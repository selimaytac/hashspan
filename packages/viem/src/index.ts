import {
  type ConfirmHandle,
  createTxTracker,
  type ReceiptLike,
  type SendInput,
  type TxTracker,
  type TxTrackerOptions,
} from '@hashspan/core';
import { diag } from '@opentelemetry/api';
import { type Abi, getAbiItem, toFunctionSelector } from 'viem';
import { waitForTransactionReceipt as viemWaitForTransactionReceipt } from 'viem/actions';
import { fetchRevertReason } from './revert-reason.js';
import { errorName, guardTracker, NOOP_SEND } from './safe-tracker.js';

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
const RECENT_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT = 10_000;

/** Per-transaction values kept for a while, keyed by `chainId:hash`. Bounded and time-limited. */
class Recent<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + RECENT_TTL_MS });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_RECENT) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    return entry.value;
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
  uid?: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: matches viem's overloaded EIP-1193 request function.
  request: (...args: any[]) => Promise<any>;
}

/** Client extension returned by {@link withHashspan}: the traced actions present on the client. */
export type HashspanExtension = <TClient extends ViemClientLike>(
  client: TClient,
) => Pick<TClient, Extract<keyof TClient, TracedAction>>;

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
  // Guarded so that no tracker, including a user-provided one, can throw into the instrumented call.
  const tracker = guardTracker(providedTracker ?? createTxTracker(trackerOptions));
  const chainIds = new WeakMap<object, Promise<number>>();
  /** ABIs of recent `writeContract` calls, to decode custom errors. */
  const abis = new Recent<Abi>();
  /** Revert reasons being or already fetched, so concurrent waits for one transaction fetch it once. */
  const revertReasons = new Recent<Promise<string | undefined>>();
  const confirmKey = (chainId: number, hash: string): string => `${chainId}:${hash.toLowerCase()}`;

  const revertReasonOf = (
    key: string,
    receipt: ViemReceipt,
    client: unknown,
  ): Promise<string | undefined> => {
    let reason = revertReasons.get(key);
    if (!reason) {
      reason = fetchRevertReason(
        client,
        receipt.transactionHash,
        receipt.blockNumber,
        abis.get(key),
      ).catch((error: unknown) => {
        diag.debug(`hashspan: could not fetch revert reason (${errorName(error)})`);
        return undefined;
      });
      revertReasons.set(key, reason);
    }
    return reason;
  };

  /**
   * Ends `handle` from the outcome of `wait`; never rejects. The tracker joins handles for one transaction into one
   * confirm span (docs/adr/0007-confirmation-ownership.md). For reverted receipts, the span ends after the revert
   * reason was fetched with `client`.
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
      if (isTimeout(error)) handle.timeout();
      else handle.fail(error);
      return;
    }
    const revertReason =
      receipt.status === 'reverted' && decodeRevertReason
        ? await revertReasonOf(key, receipt, client)
        : undefined;
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

    /**
     * The sending client under its own `uid`, for background confirmation. viem joins concurrent
     * `waitForTransactionReceipt` calls with the same client `uid` and hash into one poll that runs with the first
     * call's options: sharing it would apply the background timeout and confirmations to the caller's own wait.
     * One `uid` per client, since viem also caches by `uid`.
     */
    const backgroundClient =
      typeof client.uid === 'string' ? { ...client, uid: `${client.uid}:hashspan` } : client;

    const confirmInBackground = (chainId: number, hash: string): void => {
      const key = confirmKey(chainId, hash);
      const handle = tracker.startConfirm({ chainId, hash });
      const wait = viemWaitForTransactionReceipt(backgroundClient as never, {
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
          handle = tracker.startConfirm({ chainId, hash: args.hash });
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
