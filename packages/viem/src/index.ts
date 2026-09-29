import {
  type ConfirmHandle,
  createTxTracker,
  type ReceiptLike,
  type ReplacementReason,
  type SendInput,
  type TxTracker,
  type TxTrackerOptions,
} from '@hashspan/core';
import { type Context, context, diag, type TimeInput } from '@opentelemetry/api';
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
   * `{ timeoutMs }` bounds the replay; if the provider has not answered by then, the receipt is recorded without a
   * reason. Default: true, with a 10 000 ms bound. See docs/adr/0005-revert-reason-replay.md.
   */
  decodeRevertReason?: boolean | { timeoutMs?: number | undefined } | undefined;
}

export interface BackgroundConfirmOptions {
  mode: 'background';
  /** How long to poll for a receipt before ending the confirm span as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
}

const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
const DEFAULT_REVERT_REASON_TIMEOUT_MS = 10_000;
/** How long after a call settled its telemetry still waits for the client's chain id before it is dropped. */
const CHAIN_ID_GRACE_MS = 30_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/** Timers of the JavaScript runtime; `src/` is type-checked without runtime-specific types. */
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/** Resolves with `value`, or with undefined after `ms`. Never rejects; its timer does not keep the process alive. */
function within<T>(value: Promise<T>, ms: number, what: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => {
      diag.debug(`hashspan: gave up waiting to ${what} after ${ms} ms`);
      resolve(undefined);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const done = (result: T | undefined): void => {
      timers.clearTimeout(timer);
      resolve(result);
    };
    value.then(done, () => done(undefined));
  });
}

/**
 * Resolves with the chain id, or with undefined if the request fails or is still pending `CHAIN_ID_GRACE_MS` after
 * `settled`. Never rejects, and its timer does not keep the process alive.
 */
function chainIdOrGiveUp(
  chainId: Promise<number>,
  settled: Promise<unknown>,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let timer: unknown;
    let finished = false;
    const done = (id: number | undefined): void => {
      finished = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      resolve(id);
    };
    chainId.then(done, (error: unknown) => {
      diag.debug(`hashspan: could not resolve the chain id (${errorName(error)})`);
      done(undefined);
    });
    const startGrace = (): void => {
      // The chain id may have arrived before the call settled: then there is nothing to wait for.
      if (finished) return;
      timer = timers.setTimeout(() => {
        diag.debug('hashspan: chain id still unknown after the call settled; not recording it');
        done(undefined);
      }, CHAIN_ID_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    settled.then(startGrace, startGrace);
  });
}
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

export interface FlushOptions {
  /** Longest time to wait. Default: 10 000 ms. */
  timeoutMs?: number | undefined;
}

/** Client extension returned by {@link withHashspan}: the traced actions present on the client. */
export interface HashspanExtension {
  <TClient extends ViemClientLike>(
    client: TClient,
  ): Pick<TClient, Extract<keyof TClient, TracedAction>>;
  /**
   * Waits for tracing work still running after traced calls returned (background confirmations, revert reason
   * replays, calls recorded once their chain id is known), so their spans are ended before the OpenTelemetry SDK
   * shuts down. Resolves true when all of it finished, false on timeout; never rejects. See
   * docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
}

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
    decodeRevertReason: decodeRevertReasonOption = true,
    ...trackerOptions
  } = options;
  // Guarded so that no tracker, including a user-provided one, can throw into the instrumented call.
  const decodeRevertReason = decodeRevertReasonOption !== false;
  const revertReasonTimeoutMs =
    (typeof decodeRevertReasonOption === 'object'
      ? decodeRevertReasonOption.timeoutMs
      : undefined) ?? DEFAULT_REVERT_REASON_TIMEOUT_MS;
  const tracker = guardTracker(providedTracker ?? createTxTracker(trackerOptions));
  /** ABIs of recent `writeContract` calls, to decode custom errors. */
  const abis = new Recent<Abi>();
  /** Revert reasons being or already fetched, so concurrent waits for one transaction fetch it once. */
  const revertReasons = new Recent<Promise<string | undefined>>();
  const confirmKey = (chainId: number, hash: string): string => `${chainId}:${hash.toLowerCase()}`;
  /** Tracing work that outlives the traced call, awaited by `flush()`. */
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    const settled = work.catch(() => {});
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  };
  const flush = async ({
    timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  }: FlushOptions = {}): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    // Loop, because finishing work can start more (e.g. a late send starting a background confirmation).
    while (pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const done = await within(
        Promise.all([...pending]).then(() => true),
        remaining,
        'flush pending tracing work',
      );
      if (done === undefined) return false;
    }
    return true;
  };

  /** Revert reason of a mined transaction, fetched once per transaction (keyed by its hash). */
  const revertReasonOf = (
    key: string,
    receipt: ViemReceipt,
    abi: Abi | undefined,
    client: unknown,
  ): Promise<string | undefined> => {
    let reason = revertReasons.get(key);
    if (!reason) {
      const fetched = fetchRevertReason(
        client,
        receipt.transactionHash,
        receipt.blockNumber,
        abi,
      ).catch((error: unknown) => {
        diag.debug(`hashspan: could not fetch revert reason (${errorName(error)})`);
        return undefined;
      });
      // Bounded, so that an unresponsive provider cannot keep the confirm span open.
      reason = within(fetched, revertReasonTimeoutMs, 'fetch the revert reason');
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
    endTimeOf: () => TimeInput | undefined = () => undefined,
  ): Promise<void> => {
    let receipt: ViemReceipt;
    try {
      receipt = await wait;
    } catch (error) {
      // viem rejects after reporting a replacement only if the caller's onReplaced threw: the transaction was mined.
      const reported = capture.replacement?.transactionReceipt;
      if (!reported) {
        if (isTimeout(error)) handle.timeout(endTimeOf());
        else handle.fail(error, endTimeOf());
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
      handle.end(
        {
          ...toReceiptLike(receipt),
          revertReason,
          replacementReason: reported ? replacement.reason : undefined,
        },
        endTimeOf(),
      );
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
      handle.fail(error, endTimeOf());
    }
  };

  const extension = (client: ViemClientLike & Partial<Record<TracedAction, AnyAction>>) => {
    const knownChainId = (args: {
      chain?: { id: number } | null | undefined;
    }): number | undefined => args.chain?.id ?? client.chain?.id;

    /**
     * Asks a client without a chain for its chain id. Concurrent calls share one request; the answer is not cached,
     * since a wallet can switch networks. Callers never await it before the call they trace (docs/adr/0009).
     */
    let pendingChainId: Promise<number> | undefined;
    const queryChainId = (): Promise<number> => {
      if (!pendingChainId) {
        const query = Promise.resolve()
          .then(() => client.request({ method: 'eth_chainId' }))
          .then((hex: string) => {
            const id = Number(hex);
            if (!Number.isSafeInteger(id)) throw new TypeError('invalid chain id');
            return id;
          });
        pendingChainId = query;
        const clear = (): void => {
          if (pendingChainId === query) pendingChainId = undefined;
        };
        query.then(clear, clear);
      }
      return pendingChainId;
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
      track(recordConfirmation(chainId, hash, handle, wait, capture, client));
    };

    /** Work after a successful send: remember the ABI and start background confirmation. */
    const afterSend = (chainId: number, hash: string, abi: Abi | undefined): void => {
      try {
        if (abi) abis.set(confirmKey(chainId, hash), abi);
        if (confirm?.mode === 'background') confirmInBackground(chainId, hash);
      } catch (error) {
        diag.error(`hashspan: failed to start background confirmation (${errorName(error)})`);
      }
    };

    /**
     * Records a send whose chain id was unknown when it started, once the chain id is known: same parent context,
     * start and end time as the call. Never rejects.
     */
    const recordLateSend = async (
      ctx: Context,
      startTime: Date,
      chainId: Promise<number>,
      result: Promise<string>,
      describe: (chainId: number) => SendInput,
      abi: Abi | undefined,
    ): Promise<void> => {
      let hash: string | undefined;
      let error: unknown;
      try {
        hash = await result;
      } catch (thrown) {
        error = thrown;
      }
      const endTime = new Date();
      const id = await chainIdOrGiveUp(chainId, Promise.resolve());
      if (id === undefined) return;
      try {
        const handle = context.with(ctx, () => tracker.startSend({ ...describe(id), startTime }));
        if (hash === undefined) {
          handle.fail(error, endTime);
          return;
        }
        handle.end(hash, endTime);
        afterSend(id, hash, abi);
      } catch (thrown) {
        diag.error(`hashspan: failed to record send span (${errorName(thrown)})`);
      }
    };

    const traceSend = async (
      args: SendArgs,
      describe: (chainId: number) => SendInput,
      send: () => Promise<string>,
      abi?: Abi,
    ): Promise<string> => {
      const chainId = knownChainId(args);
      if (chainId === undefined) {
        // Telemetry must not delay the call: record it once the chain id is known (docs/adr/0009).
        const ctx = context.active();
        const startTime = new Date();
        const chainIdQuery = queryChainId();
        const result = send();
        track(recordLateSend(ctx, startTime, chainIdQuery, result, describe, abi));
        return result;
      }
      let handle = NOOP_SEND;
      try {
        handle = tracker.startSend(describe(chainId));
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
      afterSend(chainId, hash, abi);
      return hash;
    };

    const sendInput = (
      args: SendArgs,
      to: string | null | undefined,
      chainId: number,
    ): SendInput => ({
      chainId,
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
          args,
          (chainId) => ({
            ...sendInput(args, args.to, chainId),
            functionSelector: selectorOf(args.data),
          }),
          () => sendTransaction(args),
        );
    }

    if (typeof writeContract === 'function') {
      actions.writeContract = (args: WriteContractArgs) =>
        traceSend(
          args,
          (chainId) => {
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
              ...sendInput(args, args.address, chainId),
              functionName: args.functionName,
              functionSelector,
              functionArguments: args.args,
            };
          },
          () => writeContract(args),
          args.abi,
        );
    }

    if (typeof waitForTransactionReceipt === 'function') {
      /** Records a wait whose chain id was unknown when it started, once it is known. Never rejects. */
      const recordLateConfirmation = async (
        ctx: Context,
        startTime: Date,
        chainId: Promise<number>,
        hash: string,
        wait: Promise<ViemReceipt>,
        capture: ReplacementCapture,
      ): Promise<void> => {
        let endTime: Date | undefined;
        const settled = wait.then(
          () => {
            endTime = new Date();
          },
          () => {
            endTime = new Date();
          },
        );
        const id = await chainIdOrGiveUp(chainId, settled);
        if (id === undefined) return;
        try {
          const handle = context.with(ctx, () =>
            tracker.startConfirm({ chainId: id, hash, startTime }),
          );
          await recordConfirmation(
            id,
            hash,
            handle,
            wait,
            capture,
            client,
            () => endTime ?? new Date(),
          );
        } catch (error) {
          diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
        }
      };

      actions.waitForTransactionReceipt = async (args: WaitArgs) => {
        const chainId = knownChainId(args);
        let handle: ConfirmHandle | undefined;
        if (chainId !== undefined) {
          try {
            handle = tracker.startConfirm({ chainId, hash: args.hash });
          } catch (error) {
            diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
          }
        }
        const late =
          chainId === undefined
            ? { ctx: context.active(), startTime: new Date(), chainId: queryChainId() }
            : undefined;
        // Always wrapped, so that a replacement is attributed however the span is recorded (docs/adr/0008).
        const capture: ReplacementCapture = {};
        const wait = waitForTransactionReceipt({
          ...args,
          onReplaced: capturing(capture, args.onReplaced),
        }) as Promise<ViemReceipt>;
        if (handle && chainId !== undefined) {
          track(recordConfirmation(chainId, args.hash, handle, wait, capture, client));
        } else if (late) {
          track(
            recordLateConfirmation(
              late.ctx,
              late.startTime,
              late.chainId,
              args.hash,
              wait,
              capture,
            ),
          );
        }
        return wait;
      };
    }

    return actions;
  };

  return Object.assign(extension, { flush }) as HashspanExtension;
}
