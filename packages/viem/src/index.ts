import {
  type ConfirmHandle,
  createTxTracker,
  type ReceiptLike,
  type SendHandle,
  type SendInput,
  type TxTracker,
  type TxTrackerOptions,
} from '@hashspan/core';
import { diag } from '@opentelemetry/api';
import { type Abi, getAbiItem, toFunctionSelector } from 'viem';
import { waitForTransactionReceipt as viemWaitForTransactionReceipt } from 'viem/actions';
import { fetchRevertReason } from './revert-reason.js';

export interface WithHashspanOptions extends TxTrackerOptions {
  /**
   * Tracker to report to. Defaults to one tracker per `withHashspan()` call, so reuse the same
   * `withHashspan()` result for a wallet client and a public client to link sends to confirmations.
   */
  tracker?: TxTracker | undefined;
  /**
   * `{ mode: 'background' }` confirms every sent transaction without waiting for the caller to do so, by polling
   * for its receipt through the sending client. Off by default.
   */
  confirm?: BackgroundConfirmOptions | undefined;
  /**
   * Replay reverted transactions to record their revert reason (two extra RPC requests per reverted transaction).
   * Default: true. See docs/adr/0005-revert-reason-replay.md.
   */
  decodeRevertReason?: boolean | undefined;
}

export interface BackgroundConfirmOptions {
  mode: 'background';
  /** How long to poll for a receipt before ending the confirm span as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
}

const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
const CONFIRMED_TTL_MS = 10 * 60 * 1000;
const MAX_CONFIRMATIONS = 10_000;

/**
 * Transactions whose confirm span is in progress or already recorded a receipt, so each transaction gets one
 * confirm span. Bounded and time-limited; failed or timed-out confirmations are released so a retry is traced.
 */
class Confirmations {
  private readonly entries = new Map<string, number>();

  /** Claims `key`; returns false if another confirm span already covers it. */
  claim(key: string): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > Date.now()) return false;
    this.entries.delete(key);
    this.entries.set(key, Number.POSITIVE_INFINITY);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_CONFIRMATIONS) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  /** Keeps `key` claimed for a while after a receipt was recorded. */
  settle(key: string): void {
    if (this.entries.has(key)) this.entries.set(key, Date.now() + CONFIRMED_TTL_MS);
  }

  release(key: string): void {
    this.entries.delete(key);
  }
}

/** ABIs used by recent `writeContract` calls, to decode custom errors. Bounded and time-limited. */
class RecentAbis {
  private readonly entries = new Map<string, { abi: Abi; expiresAt: number }>();

  set(key: string, abi: Abi): void {
    this.entries.delete(key);
    this.entries.set(key, { abi, expiresAt: Date.now() + CONFIRMED_TTL_MS });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_CONFIRMATIONS) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string): Abi | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    return entry.abi;
  }
}

/** Actions this adapter traces. */
export type TracedAction = 'sendTransaction' | 'writeContract' | 'waitForTransactionReceipt';

// biome-ignore lint/suspicious/noExplicitAny: viem action signatures are preserved via Pick<TClient, ...>.
type AnyAction = (args: any) => Promise<any>;

/** The subset of a viem client the adapter relies on. */
export interface ViemClientLike {
  chain?: { id: number } | undefined;
  account?: { address: string } | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: matches viem's overloaded EIP-1193 request function.
  request: (...args: any[]) => Promise<any>;
}

/** Client extension returned by {@link withHashspan}: the traced actions present on the client. */
export type HashspanExtension = <TClient extends ViemClientLike>(
  client: TClient,
) => Pick<TClient, Extract<keyof TClient, TracedAction>>;

const NOOP_SEND: SendHandle = { end: () => {}, fail: () => {} };

interface SendArgs {
  account?: string | { address: string } | null | undefined;
  chain?: { id: number } | null | undefined;
  to?: string | null | undefined;
  value?: bigint | undefined;
  nonce?: number | undefined;
  data?: string | undefined;
}

interface WriteContractArgs extends SendArgs {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[] | undefined;
}

interface WaitArgs {
  hash: string;
  chain?: { id: number } | null | undefined;
}

interface ViemReceipt {
  transactionHash: `0x${string}`;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint | undefined;
  l1Fee?: bigint | string | null | undefined;
}

/**
 * What `diag` logs for an error: its name only. viem errors carry request arguments and RPC URLs, which may
 * include addresses, calldata or API keys.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError';
}

function selectorOf(data: string | undefined): string | undefined {
  return data && data.length >= 10 ? data.slice(0, 10) : undefined;
}

function addressOf(account: string | { address: string } | null | undefined): string | undefined {
  if (!account) return undefined;
  return typeof account === 'string' ? account : account.address;
}

/** Normalises a viem receipt; `l1Fee` is a bigint with the OP-stack formatter, else a raw hex string. */
function toReceiptLike(receipt: ViemReceipt): ReceiptLike {
  const { l1Fee } = receipt;
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    l1Fee: typeof l1Fee === 'string' ? BigInt(l1Fee) : l1Fee,
  };
}

/**
 * viem client extension that traces transactions with `@hashspan/core`:
 * `client.extend(withHashspan())`. Apply it after other extensions such as `publicActions`,
 * which would otherwise replace the traced actions.
 */
export function withHashspan(options: WithHashspanOptions = {}): HashspanExtension {
  const {
    tracker: providedTracker,
    confirm,
    decodeRevertReason = true,
    ...trackerOptions
  } = options;
  const tracker = providedTracker ?? createTxTracker(trackerOptions);
  const chainIds = new WeakMap<object, Promise<number>>();
  /** Shared by all clients extended with this instance, keyed by `chainId:hash`. */
  const confirmations = new Confirmations();
  const abis = new RecentAbis();
  const confirmKey = (chainId: number, hash: string): string => `${chainId}:${hash.toLowerCase()}`;

  /**
   * Ends `handle` from the outcome of `wait` and settles or releases `key`; never rejects.
   * For reverted receipts, the span ends after the revert reason was fetched with `client`.
   */
  const recordConfirmation = async (
    key: string,
    handle: ConfirmHandle,
    wait: Promise<ViemReceipt>,
    client: unknown,
  ): Promise<void> => {
    let receipt: ViemReceipt;
    try {
      receipt = await wait;
    } catch (error) {
      confirmations.release(key);
      if (isTimeout(error)) handle.timeout();
      else handle.fail(error);
      return;
    }
    confirmations.settle(key);
    let revertReason: string | undefined;
    if (receipt.status === 'reverted' && decodeRevertReason) {
      try {
        revertReason = await fetchRevertReason(
          client,
          receipt.transactionHash,
          receipt.blockNumber,
          abis.get(key),
        );
      } catch (error) {
        diag.debug(`hashspan: could not fetch revert reason (${errorName(error)})`);
      }
    }
    try {
      handle.end({ ...toReceiptLike(receipt), revertReason });
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
    }
  };

  const extension = (client: ViemClientLike & Partial<Record<TracedAction, AnyAction>>) => {
    const chainIdFor = async (args: {
      chain?: { id: number } | null | undefined;
    }): Promise<number> => {
      const known = args.chain?.id ?? client.chain?.id;
      if (known !== undefined) return known;
      let pending = chainIds.get(client);
      if (!pending) {
        pending = client.request({ method: 'eth_chainId' }).then((hex: string) => Number(hex));
        pending.catch(() => chainIds.delete(client));
        chainIds.set(client, pending);
      }
      return pending;
    };

    const confirmInBackground = (chainId: number, hash: string): void => {
      const key = confirmKey(chainId, hash);
      if (!confirmations.claim(key)) return;
      const handle = tracker.startConfirm({ chainId, hash });
      const wait = viemWaitForTransactionReceipt(client as never, {
        hash: hash as `0x${string}`,
        timeout: confirm?.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
      }) as Promise<ViemReceipt>;
      void recordConfirmation(key, handle, wait, client);
    };

    const traceSend = async (
      describe: () => Promise<SendInput>,
      send: () => Promise<string>,
      abi?: Abi,
    ): Promise<string> => {
      let handle = NOOP_SEND;
      let chainId: number | undefined;
      try {
        const input = await describe();
        chainId = input.chainId;
        handle = tracker.startSend(input);
      } catch (error) {
        diag.error(`hashspan: failed to start send span (${errorName(error)})`);
      }
      let hash: string;
      try {
        hash = await send();
      } catch (error) {
        handle.fail(error);
        throw error;
      }
      handle.end(hash);
      if (abi && chainId !== undefined) abis.set(confirmKey(chainId, hash), abi);
      if (confirm?.mode === 'background' && chainId !== undefined) {
        try {
          confirmInBackground(chainId, hash);
        } catch (error) {
          diag.error(`hashspan: failed to start background confirmation (${errorName(error)})`);
        }
      }
      return hash;
    };

    const sendInput = async (
      args: SendArgs,
      to: string | null | undefined,
    ): Promise<SendInput> => ({
      chainId: await chainIdFor(args),
      from: addressOf(args.account ?? client.account),
      to: to ?? undefined,
      value: args.value,
      nonce: args.nonce,
    });

    const actions: Partial<Record<TracedAction, AnyAction>> = {};
    const { sendTransaction, writeContract, waitForTransactionReceipt } = client;

    if (typeof sendTransaction === 'function') {
      actions.sendTransaction = (args: SendArgs) =>
        traceSend(
          async () => ({
            ...(await sendInput(args, args.to)),
            functionSelector: selectorOf(args.data),
          }),
          () => sendTransaction(args),
        );
    }

    if (typeof writeContract === 'function') {
      actions.writeContract = (args: WriteContractArgs) =>
        traceSend(
          async () => {
            let functionSelector: string | undefined;
            try {
              const item = getAbiItem({
                abi: args.abi,
                name: args.functionName,
                args: args.args,
              } as never);
              functionSelector = item ? toFunctionSelector(item as never) : undefined;
            } catch {
              // Unknown or ambiguous ABI item: record the function name only.
            }
            return {
              ...(await sendInput(args, args.address)),
              functionName: args.functionName,
              functionSelector,
            };
          },
          () => writeContract(args),
          args.abi,
        );
    }

    if (typeof waitForTransactionReceipt === 'function') {
      actions.waitForTransactionReceipt = async (args: WaitArgs) => {
        let handle: ConfirmHandle | undefined;
        let key: string | undefined;
        try {
          const chainId = await chainIdFor(args);
          key = confirmKey(chainId, args.hash);
          // A background confirmation already covers this transaction: one confirm span per transaction.
          if (confirmations.claim(key)) handle = tracker.startConfirm({ chainId, hash: args.hash });
        } catch (error) {
          diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
        }
        const wait = waitForTransactionReceipt(args) as Promise<ViemReceipt>;
        if (handle && key) void recordConfirmation(key, handle, wait, client);
        return wait;
      };
    }

    return actions;
  };

  return extension as HashspanExtension;
}
