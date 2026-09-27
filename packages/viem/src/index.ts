import {
  type ConfirmHandle,
  createTxTracker,
  type ReceiptLike,
  type ReplacementReason,
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
  onReplaced?: ((replacement: ViemReplacement) => void) | undefined;
}

/** What viem passes to `onReplaced`. */
interface ViemReplacement {
  reason: ReplacementReason;
  replacedTransaction: { to?: string | null | undefined };
  transaction: { to?: string | null | undefined };
  transactionReceipt: ViemReceipt;
}

/** The replacement viem reported to one wait, if any. */
interface ReplacementCapture {
  replacement?: ViemReplacement | undefined;
}

/**
 * `onReplaced` for a wait: stores the replacement first, then calls the caller's callback with the same argument.
 * What the callback throws still rejects the wait, as in plain viem.
 */
function capturing(
  capture: ReplacementCapture,
  onReplaced: ((replacement: ViemReplacement) => void) | undefined,
): (replacement: ViemReplacement) => void {
  return (replacement) => {
    capture.replacement = replacement;
    onReplaced?.(replacement);
  };
}

/** Case-insensitive equality of two hex strings (addresses or hashes); false unless both are strings. */
function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
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
    transactionHash: receipt.transactionHash,
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

  /** Revert reason of a mined transaction, fetched once per transaction (keyed by its hash). */
  const revertReasonOf = (
    key: string,
    receipt: ViemReceipt,
    abi: Abi | undefined,
    client: unknown,
  ): Promise<string | undefined> => {
    let reason = revertReasons.get(key);
    if (!reason) {
      reason = fetchRevertReason(client, receipt.transactionHash, receipt.blockNumber, abi).catch(
        (error: unknown) => {
          diag.debug(`hashspan: could not fetch revert reason (${errorName(error)})`);
          return undefined;
        },
      );
      revertReasons.set(key, reason);
    }
    return reason;
  };

  /**
   * Ends `handle` from the outcome of `wait`; never rejects. The tracker joins handles for one transaction into one
   * confirm span (docs/adr/0007-confirmation-ownership.md) and attributes the receipt of a replacing transaction to
   * that transaction (docs/adr/0008-replaced-transactions.md). For reverted receipts, the span ends after the
   * revert reason was fetched with `client`.
   */
  const recordConfirmation = async (
    chainId: number,
    hash: string,
    handle: ConfirmHandle,
    wait: Promise<ViemReceipt>,
    capture: ReplacementCapture,
    client: unknown,
  ): Promise<void> => {
    let receipt: ViemReceipt;
    try {
      receipt = await wait;
    } catch (error) {
      // viem rejects after reporting a replacement only if the caller's onReplaced threw: the transaction was mined.
      const reported = capture.replacement?.transactionReceipt;
      if (!reported) {
        if (isTimeout(error)) handle.timeout();
        else handle.fail(error);
        return;
      }
      receipt = reported;
    }
    try {
      const { replacement } = capture;
      const reported =
        replacement !== undefined &&
        sameHex(replacement.transactionReceipt.transactionHash, receipt.transactionHash);
      let revertReason: string | undefined;
      // A malformed hash is left to the tracker, which does not attribute it.
      if (
        receipt.status === 'reverted' &&
        decodeRevertReason &&
        typeof receipt.transactionHash === 'string'
      ) {
        const minedKey = confirmKey(chainId, receipt.transactionHash);
        // Errors are matched by selector, so the original call's ABI fits a replacing call to the same contract.
        const abi =
          abis.get(minedKey) ??
          (minedKey === confirmKey(chainId, hash) ||
          (reported && sameHex(replacement.transaction.to, replacement.replacedTransaction.to))
            ? abis.get(confirmKey(chainId, hash))
            : undefined);
        revertReason = await revertReasonOf(minedKey, receipt, abi, client);
      }
      handle.end({
        ...toReceiptLike(receipt),
        revertReason,
        replacementReason: reported ? replacement.reason : undefined,
      });
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
      handle.fail(error);
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
      const handle = tracker.startConfirm({ chainId, hash });
      const capture: ReplacementCapture = {};
      const wait = viemWaitForTransactionReceipt(backgroundClient as never, {
        hash: hash as `0x${string}`,
        timeout: confirm?.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
        onReplaced: capturing(capture, undefined) as never,
      }) as Promise<ViemReceipt>;
      void recordConfirmation(chainId, hash, handle, wait, capture, client);
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
        let chainId: number | undefined;
        try {
          chainId = await chainIdFor(args);
          handle = tracker.startConfirm({ chainId, hash: args.hash });
        } catch (error) {
          diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
        }
        const capture: ReplacementCapture = {};
        const wait = waitForTransactionReceipt(
          handle ? { ...args, onReplaced: capturing(capture, args.onReplaced) } : args,
        ) as Promise<ViemReceipt>;
        if (handle && chainId !== undefined) {
          void recordConfirmation(chainId, args.hash, handle, wait, capture, client);
        }
        return wait;
      };
    }

    return actions;
  };

  return extension as HashspanExtension;
}
