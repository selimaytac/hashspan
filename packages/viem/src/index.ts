import {
  type CallBatchConfirmHandle,
  type CallBatchInput,
  type CallBatchStatusLike,
  type ConfirmHandle,
  createTxTracker,
  type ReceiptLike,
  type ReplacementReason,
  type SendInput,
  type TxTracker,
  type TxTrackerOptions,
  type UserOperationConfirmHandle,
  type UserOperationInput,
  type UserOperationReceiptLike,
} from '@hashspan/core';
import { type Context, context, diag, type TimeInput } from '@opentelemetry/api';
import {
  type Abi,
  getAbiItem,
  type TransactionReceipt,
  toFunctionSelector,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import * as viemActions from 'viem/actions';
import {
  getTransactionReceipt as viemGetTransactionReceipt,
  waitForTransactionReceipt as viemWaitForTransactionReceipt,
} from 'viem/actions';
import { fetchRevertReason, formatRevertData } from './revert-reason.js';
import { errorName, guardTracker } from './safe-tracker.js';

export { type TraceTransportOptions, traceTransport } from './transport.js';

export interface WithHashspanOptions extends TxTrackerOptions {
  /**
   * Tracker from `createTxTracker()` to report to, to share one between adapters. Defaults to one tracker per
   * `withHashspan()` call, so reuse the same `withHashspan()` result for a wallet client and a public client to link
   * sends to confirmations.
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
   * reason. Default: true, with a 10 000 ms bound. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0005-revert-reason-replay.md.
   */
  decodeRevertReason?: boolean | { timeoutMs?: number | undefined } | undefined;
  /**
   * Most background confirmations (`confirm: { mode: 'background' }` and `watch()`) polling at once. A transaction
   * sent while that many are polling gets no background confirm span, and a `diag` warning is logged; waits of the
   * caller are not counted and always traced. Default: 256. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0018-background-confirmation-limit.md.
   */
  maxBackgroundConfirmations?: number | undefined;
}

export interface BackgroundConfirmOptions {
  /** Confirm every transaction sent through the extended clients, whether or not the caller waits for it. */
  mode: 'background';
  /** How long to poll for a receipt before ending the confirm span as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
}

const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BACKGROUND_CONFIRMATIONS = 256;
const DEFAULT_REVERT_REASON_TIMEOUT_MS = 10_000;
/** How long after a call settled its telemetry still waits for the client's chain id before it is dropped. */
const CHAIN_ID_GRACE_MS = 30_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
/** How long telemetry waits for the sealed receipt of a preconfirmed transaction before it records it without fees. */
const SEALED_RECEIPT_TIMEOUT_MS = 30_000;

/** Timers of the JavaScript runtime; `src/` is type-checked without runtime-specific types. */
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/**
 * Resolves true once all of `work` has settled, or false after `ms`. Unlike the other internal timers, this one is
 * referenced: `flush()` is awaited before shutting down, so the process must stay alive until it resolves.
 */
function settledWithin(work: Promise<unknown>[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve(false), ms);
    void Promise.all(work).then(() => {
      timers.clearTimeout(timer);
      resolve(true);
    });
  });
}

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

/**
 * Actions this adapter traces: those of a wallet client, two of a bundler client (`createBundlerClient`), and the
 * EIP-5792 call batch actions of a wallet client.
 */
export type TracedAction =
  | 'sendTransaction'
  | 'writeContract'
  | 'waitForTransactionReceipt'
  | 'sendUserOperation'
  | 'waitForUserOperationReceipt'
  | 'sendCalls'
  | 'sendCallsSync'
  | 'waitForCallsStatus';

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
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
  /**
   * Confirms a transaction sent outside the extended clients (for example by a wallet API) through `client`, in the
   * background: a confirm span with the receipt, revert reason and fees, linked to the send span when the same
   * tracker recorded one. Never throws and never waits; `flush()` awaits it. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0012-cdp-adapter.md.
   */
  watch(client: ViemClientLike, options: WatchOptions): void;
}

export interface WatchOptions {
  /** Transaction hash. */
  hash: string;
  /**
   * EIP-155 chain id; defaults to the client's chain. Without either, nothing is recorded; when it differs from the
   * client's chain, nothing is recorded either and a `diag` warning is logged.
   */
  chainId?: number | undefined;
  /** How long to poll for the receipt before the confirm span ends as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
  /** ABI of the called contract, to decode custom errors in the revert reason. */
  abi?: Abi | undefined;
  /**
   * Called once when the watch ends: with the receipt of the mined transaction (of a replacing transaction, if one
   * was mined instead), or with `undefined` when no receipt was retrieved (timeout, failure, or nothing watched). Its
   * result and errors are ignored; it never affects the confirm span. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0017-x402-payment-verification.md.
   */
  onReceipt?: ((receipt: TransactionReceipt | undefined) => void) | undefined;
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
  blockHash?: string | null | undefined;
}

/**
 * Whether `receipt` is a preconfirmation: a flashblocks node returns a receipt before its block is sealed, with a zero
 * (or null) block hash, and its `l1Fee` can be that of another transaction. Fees are recorded from the sealed receipt
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0024-sealed-receipt-fees.md).
 */
function isPreconfirmed(receipt: ViemReceipt): boolean {
  const { blockHash } = receipt;
  return blockHash === null || (typeof blockHash === 'string' && /^0x0*$/.test(blockHash));
}

/** `receipt` without the fields that make up its fee, for a preconfirmed receipt whose sealed one never came. */
function withoutFees(receipt: ReceiptLike): ReceiptLike {
  return { ...receipt, effectiveGasPrice: undefined, l1Fee: undefined };
}

// The suffix of the id viem returns for a batch it sent as plain transactions (`experimental_fallback`): the
// transaction hashes (a zero hash for a call that failed to send), the chain id, then this. Copied from viem; the
// fallback tests in test/call-batch.test.ts and test/call-batch.int.test.ts run the installed viem's fallback.
const FALLBACK_ID_SUFFIX = '5792'.repeat(16);

/** The transactions of a fallback batch id, without failed calls; undefined for any other id. */
function fallbackTransactionHashes(id: string): string[] | undefined {
  if (!/^0x(?:[0-9a-fA-F]{64}){3,}$/.test(id) || !id.endsWith(FALLBACK_ID_SUFFIX)) return undefined;
  const words = id.slice(2, -128).match(/.{64}/g) ?? [];
  return words.filter((word) => !/^0+$/.test(word)).map((word) => `0x${word}`);
}

/** The id of a `sendCalls` result: an object with `id`, or a string from viem's earlier experimental action. */
function callBatchIdOf(result: unknown): string | undefined {
  const id = typeof result === 'string' ? result : own(result, 'id');
  return typeof id === 'string' ? id : undefined;
}

/** Normalises a viem call batch status; read from own data properties only. */
function toCallBatchStatusLike(status: unknown): CallBatchStatusLike {
  const statusCode = own(status, 'statusCode');
  const atomic = own(status, 'atomic');
  const receipts = own(status, 'receipts');
  const length = Array.isArray(receipts) ? own(receipts, 'length') : 0;
  return {
    statusCode: typeof statusCode === 'number' ? statusCode : undefined,
    atomic: typeof atomic === 'boolean' ? atomic : undefined,
    receipts: Array.from({ length: typeof length === 'number' ? length : 0 }, (_, i) => {
      const receipt = own(receipts, String(i));
      const transactionHash = own(receipt, 'transactionHash');
      const blockNumber = own(receipt, 'blockNumber');
      return {
        transactionHash: typeof transactionHash === 'string' ? transactionHash : undefined,
        blockNumber:
          typeof blockNumber === 'bigint' || typeof blockNumber === 'number'
            ? blockNumber
            : undefined,
      };
    }),
  };
}

function isCallsTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'WaitForCallsStatusTimeoutError';
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError';
}

/** viem gives up waiting for a user operation receipt with this error, on its timeout or after `retryCount` polls. */
function isUserOperationTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'WaitForUserOperationReceiptTimeoutError';
}

/** What viem's `waitForUserOperationReceipt` returns, as far as the adapter reads it. */
interface ViemUserOperationReceipt {
  success?: unknown;
  actualGasCost?: unknown;
  actualGasUsed?: unknown;
  sender?: unknown;
  nonce?: unknown;
  paymaster?: unknown;
  entryPoint?: unknown;
  reason?: unknown;
  receipt?: { transactionHash?: unknown; blockNumber?: unknown } | undefined;
}

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * Normalises viem's user operation receipt. The core checks every value, since they come from the bundler. viem
 * types `nonce` as a bigint but passes on the bundler's hex string; the core accepts both. `reason` is the revert
 * data of the operation's call, decoded like a transaction's (without an ABI, a custom error is its selector).
 */
function toUserOperationReceiptLike(receipt: ViemUserOperationReceipt): UserOperationReceiptLike {
  const { reason } = receipt;
  const bundle = receipt.receipt;
  return {
    success: receipt.success as boolean | undefined,
    actualGasCost: receipt.actualGasCost as bigint | undefined,
    actualGasUsed: receipt.actualGasUsed as bigint | undefined,
    sender: receipt.sender as string | undefined,
    nonce: receipt.nonce as bigint | string | undefined,
    paymaster: receipt.paymaster as string | undefined,
    entryPoint: receipt.entryPoint as string | undefined,
    revertReason:
      receipt.success === false && typeof reason === 'string' && HEX_DATA.test(reason)
        ? formatRevertData(reason as `0x${string}`, undefined)
        : undefined,
    transactionHash: bundle?.transactionHash as string | undefined,
    blockNumber: bundle?.blockNumber as bigint | undefined,
  };
}

/**
 * viem gives up waiting when a node returns a mined transaction before its receipt: it looks for a replacement,
 * finds the transaction itself in the block and fails to fetch its receipt again. Background confirmation waits
 * again after these errors, until its timeout.
 */
function isReceiptLag(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TransactionReceiptNotFoundError' || error.name === 'TransactionNotFoundError')
  );
}
const RECEIPT_LAG_RETRY_MS = 1_000;

/** Resolves after `ms`; its timer does not keep the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * The sealed receipt of the preconfirmed `receipt`, read through `client` until `deadline`; undefined if none came.
 * Never rejects: a missing receipt, a failed request or another preconfirmation is retried.
 */
async function sealedReceipt(
  client: unknown,
  receipt: ViemReceipt,
  deadline: number,
): Promise<ViemReceipt | undefined> {
  const polling = (client as { pollingInterval?: unknown } | null)?.pollingInterval;
  const retryMs = typeof polling === 'number' && polling > 0 ? polling : RECEIPT_LAG_RETRY_MS;
  for (;;) {
    try {
      const sealed = (await viemGetTransactionReceipt(client as never, {
        hash: receipt.transactionHash,
      })) as ViemReceipt;
      if (!isPreconfirmed(sealed)) return sealed;
    } catch (error) {
      diag.debug(`hashspan: the sealed receipt is not available yet (${errorName(error)})`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await delay(Math.min(retryMs, remaining));
  }
}

function selectorOf(data: string | undefined): string | undefined {
  return data && data.length >= 10 ? data.slice(0, 10) : undefined;
}

/**
 * The value of `target`'s own data property `key`, or undefined for an accessor, an inherited or a missing
 * property. Telemetry reads the user's call arguments only this way, so it never runs a getter: a getter with side
 * effects, or one that returns a different value per read, would otherwise change what the call sends. A Proxy's
 * `getOwnPropertyDescriptor` trap still runs.
 */
function own(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function'))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

const MAX_ARGUMENTS_COPY_DEPTH = 8;
// Deep enough for nested tuples, which add two levels each.
const MAX_ABI_COPY_DEPTH = 32;

/**
 * A copy of `value` made of own data properties only, for code that reads it deeply (viem's ABI matching);
 * accessors become undefined and nothing deeper than `maxDepth` is copied.
 */
function dataOnly(value: unknown, maxDepth: number, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return undefined;
  if (Array.isArray(value)) {
    const length = own(value, 'length');
    return Array.from({ length: typeof length === 'number' ? length : 0 }, (_, i) =>
      dataOnly(own(value, String(i)), maxDepth, depth + 1),
    );
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = dataOnly(own(value, key), maxDepth, depth + 1);
  return copy;
}

/**
 * The ABI items telemetry needs, copied without accessors: the functions named `functionName`, for the selector,
 * and the errors, to decode revert reasons. viem gets this copy, never the caller's ABI, so no getter in it runs.
 */
function abiForTelemetry(abi: unknown, functionName: unknown): Abi | undefined {
  if (!Array.isArray(abi)) return undefined;
  const length = own(abi, 'length');
  const items: unknown[] = [];
  for (let i = 0; i < (typeof length === 'number' ? length : 0); i++) {
    const item = own(abi, String(i));
    const type = own(item, 'type');
    if (type === 'error' || (type === 'function' && own(item, 'name') === functionName)) {
      items.push(dataOnly(item, MAX_ABI_COPY_DEPTH));
    }
  }
  return items as Abi;
}

/** The descriptor of `key` on `target` or the first prototype that has it; reading it runs no getter. */
function descriptorOf(target: object, key: string): PropertyDescriptor | undefined {
  for (
    let object: object | null = target;
    object !== null;
    object = Object.getPrototypeOf(object)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

/**
 * `target` with `key` shadowed by `value`: an object whose prototype is `target`, so inherited properties read through,
 * that also carries `target`'s own properties as they are (data as data, accessors as accessors, so no getter runs).
 * This works for frozen objects, keeps the number of times a getter runs, and keeps the own properties for code that
 * copies the options with a spread, such as another extension applied before this one.
 */
function shadowing<T extends object>(target: T, key: string, value: unknown): T {
  const descriptors = Object.getOwnPropertyDescriptors(target) as PropertyDescriptorMap;
  delete descriptors[key];
  return Object.create(target, {
    ...descriptors,
    [key]: { value, enumerable: true, writable: true, configurable: true },
  }) as T;
}

function addressOf(account: unknown): string | undefined {
  if (typeof account === 'string') return account;
  const address = own(account, 'address');
  return typeof address === 'string' ? address : undefined;
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

/** A confirm handle of a transaction or of a user operation. */
type AnyConfirmHandle = ConfirmHandle | UserOperationConfirmHandle | CallBatchConfirmHandle;

/**
 * A started send span, of a transaction, a user operation or a call batch, as `traceSend` ends it; `R` is what the
 * call returned: a hash, or a call batch's result.
 */
interface StartedSend<R = string> {
  context: Context;
  end(result: R, endTime?: Date): void;
  fail(error: unknown, endTime?: Date): void;
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
    maxBackgroundConfirmations: maxBackgroundOption,
    ...trackerOptions
  } = options;
  const maxBackgroundConfirmations =
    typeof maxBackgroundOption === 'number' && maxBackgroundOption >= 0
      ? maxBackgroundOption
      : DEFAULT_MAX_BACKGROUND_CONFIRMATIONS;
  /** Background confirmations polling now, and whether the limit was reported since the count was last below it. */
  let backgroundCount = 0;
  let limitReported = false;
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
  /** Ends a confirm handle that is still waiting as `timeout`, for `flush()` to call when it cannot wait longer. */
  const waiting = new Set<() => void>();
  const flush = async ({
    timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  }: FlushOptions = {}): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    // Loop, because finishing work can start more (e.g. a late send starting a background confirmation).
    while (pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await settledWithin([...pending], remaining))) {
        // End what is left, so its spans are exported with the rest (docs/adr/0010).
        for (const abandon of [...waiting]) {
          try {
            abandon();
          } catch (error) {
            diag.error(`hashspan: failed to end a pending confirm span (${errorName(error)})`);
          }
        }
        diag.debug(`hashspan: flush gave up after ${timeoutMs} ms`);
        return false;
      }
    }
    return true;
  };

  interface PendingConfirmation<H extends AnyConfirmHandle = ConfirmHandle> {
    /** Ends the wrapped handle at most once; later calls are ignored. */
    handle: H;
    /** Resolves once the handle has ended, by any path. */
    ended: Promise<void>;
    /** How `flush()` ends the underlying handle if it cannot wait any longer; `timeout` until replaced. */
    onAbandon(abandon: (handle: H) => void): void;
  }

  /** Wraps `handle` so it ends at most once, and registers it with `flush()` until it has ended. */
  const settleOnce = <H extends AnyConfirmHandle>(handle: H): PendingConfirmation<H> => {
    let settled = false;
    let resolveEnded: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const settle = (end: () => void): void => {
      if (settled) return;
      settled = true;
      waiting.delete(abandon);
      try {
        end();
      } finally {
        resolveEnded();
      }
    };
    let onAbandon = (underlying: H): void => underlying.timeout();
    const abandon = (): void => settle(() => onAbandon(handle));
    waiting.add(abandon);
    return {
      handle: {
        end: (...args: unknown[]) => settle(() => Reflect.apply(handle.end, handle, args)),
        timeout: (...args: unknown[]) => settle(() => Reflect.apply(handle.timeout, handle, args)),
        fail: (...args: unknown[]) => settle(() => Reflect.apply(handle.fail, handle, args)),
      } as H,
      ended,
      onAbandon: (abandonWith) => {
        onAbandon = abandonWith;
      },
    };
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
   * confirm span
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0007-confirmation-ownership.md) and
   * attributes the receipt of a replacing transaction to that transaction
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0008-replaced-transactions.md). For
   * reverted receipts, the span ends after the revert reason was fetched with `client`. For a preconfirmed receipt, it
   * ends with the sealed receipt, read with `client` until `deadline` at the latest
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0024-sealed-receipt-fees.md).
   */
  const recordReceipt = async (
    chainId: number,
    hash: string,
    confirmation: PendingConfirmation,
    wait: Promise<ViemReceipt>,
    capture: ReplacementCapture,
    client: unknown,
    endTimeOf: () => TimeInput | undefined = () => undefined,
    deadline?: number,
  ): Promise<void> => {
    const { handle } = confirmation;
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
      const replacementReason = reported ? replacement.reason : undefined;
      let recorded = toReceiptLike(receipt);
      let endAt = endTimeOf;
      if (isPreconfirmed(receipt)) {
        // The span ends when the receipt arrived, not when the sealed one was read, so its duration stays the wait's.
        const arrivedAt = endTimeOf() ?? new Date();
        endAt = () => arrivedAt;
        // Its fee may be another transaction's. A flush that cannot wait records it without fees.
        const preconfirmed = { ...withoutFees(recorded), replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(preconfirmed, endAt()));
        const sealed = await sealedReceipt(
          client,
          receipt,
          Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + SEALED_RECEIPT_TIMEOUT_MS),
        );
        if (sealed) {
          receipt = sealed;
          recorded = toReceiptLike(sealed);
        } else {
          diag.warn(
            'hashspan: no sealed receipt for a preconfirmed transaction; recording it without fees',
          );
          recorded = withoutFees(recorded);
        }
      }
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
        // The receipt is known: a flush that cannot wait for the reason records the receipt without it.
        const mined = { ...recorded, replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(mined, endAt()));
        revertReason = await revertReasonOf(minedKey, receipt, abi, client);
      }
      handle.end({ ...recorded, revertReason, replacementReason }, endAt());
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
      handle.fail(error, endTimeOf());
    }
  };
  /**
   * Records the outcome of `wait` on `waitingHandle`; never rejects. Resolves as soon as the handle has ended,
   * including when a flush that gave up ended it
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0010-flush-before-shutdown.md), so the
   * tracked work drains.
   */
  const recordConfirmation = (
    chainId: number,
    hash: string,
    waitingHandle: ConfirmHandle,
    wait: Promise<ViemReceipt>,
    capture: ReplacementCapture,
    client: unknown,
    endTimeOf: () => TimeInput | undefined = () => undefined,
    deadline?: number,
  ): Promise<void> => {
    const confirmation = settleOnce(waitingHandle);
    return Promise.race([
      recordReceipt(chainId, hash, confirmation, wait, capture, client, endTimeOf, deadline),
      confirmation.ended,
    ]);
  };

  /**
   * Each client under its own `uid`, for background confirmation. viem joins concurrent `waitForTransactionReceipt`
   * calls with the same client `uid` and hash into one poll that runs with the first call's options: sharing it would
   * apply the background timeout and confirmations to the caller's own wait. One `uid` per client, since viem also
   * caches by `uid`.
   */
  const backgroundClients = new WeakMap<object, ViemClientLike>();
  const backgroundClientOf = (client: ViemClientLike): ViemClientLike => {
    let background = backgroundClients.get(client);
    if (!background) {
      background =
        typeof client.uid === 'string' ? { ...client, uid: `${client.uid}:hashspan` } : client;
      backgroundClients.set(client, background);
    }
    return background;
  };

  /**
   * Starts a confirm span for `hash` and polls for its receipt through `client`, off the caller's path. Returns false,
   * recording nothing, when `maxBackgroundConfirmations` are already polling.
   */
  const confirmThrough = (
    client: ViemClientLike,
    chainId: number,
    hash: string,
    timeoutMs: number,
    onReceipt?: (receipt: TransactionReceipt | undefined) => void,
  ): boolean => {
    if (backgroundCount >= maxBackgroundConfirmations) {
      if (!limitReported) {
        limitReported = true;
        diag.warn(
          `hashspan: ${maxBackgroundConfirmations} background confirmations are already polling; not confirming more until one ends (maxBackgroundConfirmations)`,
        );
      }
      return false;
    }
    const handle = tracker.startConfirm({ chainId, hash });
    const capture: ReplacementCapture = {};
    const background = backgroundClientOf(client);
    const polling = (client as { pollingInterval?: unknown }).pollingInterval;
    const retryMs = typeof polling === 'number' && polling > 0 ? polling : RECEIPT_LAG_RETRY_MS;
    const deadline = Date.now() + timeoutMs;
    const wait = async (): Promise<ViemReceipt> => {
      for (;;) {
        try {
          return (await viemWaitForTransactionReceipt(background as never, {
            hash: hash as `0x${string}`,
            timeout: Math.max(deadline - Date.now(), 1),
            onReplaced: capturing(capture, undefined) as never,
          })) as ViemReceipt;
        } catch (error) {
          if (!isReceiptLag(error) || capture.replacement) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new WaitForTransactionReceiptTimeoutError({ hash: hash as `0x${string}` });
          diag.debug(
            'hashspan: the node returned the transaction before its receipt; waiting again',
          );
          await delay(Math.min(retryMs, remaining));
        }
      }
    };
    backgroundCount++;
    const waited = wait();
    const release = (): void => {
      backgroundCount--;
      if (backgroundCount < maxBackgroundConfirmations) limitReported = false;
    };
    waited.then(release, release);
    track(recordConfirmation(chainId, hash, handle, waited, capture, client, undefined, deadline));
    // Not tracked: flush() waits for the confirm span, not for the caller's callback.
    if (onReceipt) {
      void waited.then(
        (receipt) => onReceipt(receipt as unknown as TransactionReceipt),
        () => onReceipt(undefined),
      );
    }
    return true;
  };

  const watch = (client: ViemClientLike, options: WatchOptions): void => {
    let called = false;
    /** Calls the caller's `onReceipt` once, never throwing into the watch. */
    const onReceipt = (receipt: TransactionReceipt | undefined): void => {
      if (called) return;
      called = true;
      try {
        const callback: unknown = options.onReceipt;
        if (typeof callback === 'function') callback(receipt);
      } catch (error) {
        diag.error(`hashspan: the onReceipt callback of watch() failed (${errorName(error)})`);
      }
    };
    try {
      const chainId = options.chainId ?? client.chain?.id;
      if (chainId === undefined) {
        diag.debug('hashspan: watch() needs a chain id or a client with a chain; not recording it');
        onReceipt(undefined);
        return;
      }
      // Polling another chain would only end in a timeout, recorded for the wrong chain.
      const clientChainId = client.chain?.id;
      if (clientChainId !== undefined && clientChainId !== chainId) {
        diag.warn(
          `hashspan: watch() got chain ${chainId} and a client on chain ${clientChainId}; not recording it`,
        );
        onReceipt(undefined);
        return;
      }
      if (options.abi) abis.set(confirmKey(chainId, options.hash), options.abi);
      const timeoutMs = options.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;
      if (!confirmThrough(client, chainId, options.hash, timeoutMs, onReceipt))
        onReceipt(undefined);
    } catch (error) {
      diag.error(`hashspan: failed to watch a transaction (${errorName(error)})`);
      onReceipt(undefined);
    }
  };

  const extension = (client: ViemClientLike & Partial<Record<TracedAction, AnyAction>>) => {
    const knownChainId = (args: {
      chain?: { id: number } | null | undefined;
    }): number | undefined => {
      const id = own(own(args, 'chain'), 'id');
      return typeof id === 'number' ? id : client.chain?.id;
    };

    /**
     * Asks a client without a chain for its chain id. Concurrent calls share one request; the answer is not cached,
     * since a wallet can switch networks. Callers never await it before the call they trace
     * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.8.0/docs/adr/0009-telemetry-off-the-call-path.md).
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

    /** Work after a successful send: remember the ABI and start background confirmation. */
    const afterSend = (chainId: number, hash: string, abi: Abi | undefined): void => {
      try {
        if (abi) abis.set(confirmKey(chainId, hash), abi);
        if (confirm?.mode === 'background') {
          confirmThrough(client, chainId, hash, confirm.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS);
        }
      } catch (error) {
        diag.error(`hashspan: failed to start background confirmation (${errorName(error)})`);
      }
    };

    /** How `traceSend` records one kind of send: a transaction, a user operation or a call batch. */
    interface SendTrace<R = string> {
      /** The chain id when it is known before the call. Reads the call's arguments, so it may throw. */
      chainId(): number | undefined;
      /** Starts the send span, in the active context. */
      start(chainId: number, startTime?: Date): StartedSend<R>;
      /** Work after a successful send. */
      after(chainId: number, result: R): void;
    }

    /**
     * Records a send whose chain id was unknown when it started, once the chain id is known: same parent context,
     * start and end time as the call. Never rejects.
     */
    const recordLateSend = async <R>(
      ctx: Context,
      startTime: Date,
      chainId: Promise<number>,
      result: Promise<R>,
      sendTrace: SendTrace<R>,
    ): Promise<void> => {
      let sent: { value: R } | undefined;
      let error: unknown;
      try {
        sent = { value: await result };
      } catch (thrown) {
        error = thrown;
      }
      const endTime = new Date();
      const id = await chainIdOrGiveUp(chainId, Promise.resolve());
      if (id === undefined) return;
      try {
        const handle = context.with(ctx, () => sendTrace.start(id, startTime));
        if (sent === undefined) {
          handle.fail(error, endTime);
          return;
        }
        handle.end(sent.value, endTime);
        sendTrace.after(id, sent.value);
      } catch (thrown) {
        diag.error(`hashspan: failed to record send span (${errorName(thrown)})`);
      }
    };

    const traceSend = async <R>(sendTrace: SendTrace<R>, send: () => Promise<R>): Promise<R> => {
      let chainId: number | undefined;
      try {
        chainId = sendTrace.chainId();
      } catch (error) {
        untraced(error);
        return send();
      }
      if (chainId === undefined) {
        // Telemetry must not delay the call: record it once the chain id is known (docs/adr/0009).
        const ctx = context.active();
        const startTime = new Date();
        const chainIdQuery = queryChainId();
        const result = send();
        track(recordLateSend(ctx, startTime, chainIdQuery, result, sendTrace));
        return result;
      }
      let handle: StartedSend<R> = { context: context.active(), end: () => {}, fail: () => {} };
      try {
        handle = sendTrace.start(chainId);
      } catch (error) {
        diag.error(`hashspan: failed to start send span (${errorName(error)})`);
      }
      let result: R;
      try {
        // Only the call runs in the send span's context, so the spans it creates nest under the send span; what
        // follows runs in the caller's (ADR 0015). The guarded tracker always provides a context.
        result = await context.with(handle.context, send);
      } catch (error) {
        handle.fail(error);
        throw error;
      }
      handle.end(result);
      sendTrace.after(chainId, result);
      return result;
    };

    /** Records a transaction sent with `args`, described by `describe`; `abi` decodes its revert reason later. */
    const transactionSend = (
      args: SendArgs,
      describe: (chainId: number) => SendInput,
      abi?: Abi,
    ): SendTrace => ({
      chainId: () => knownChainId(args),
      start: (chainId, startTime) => {
        const handle = tracker.startSend(
          startTime === undefined ? describe(chainId) : { ...describe(chainId), startTime },
        );
        return {
          context: handle.context,
          end: (hash, endTime) => handle.end(hash, endTime),
          fail: (error, endTime) => handle.fail(error, endTime),
        };
      },
      after: (chainId, hash) => afterSend(chainId, hash, abi),
    });

    const sendInput = (
      args: SendArgs,
      to: string | null | undefined,
      chainId: number,
    ): SendInput => ({
      chainId,
      from: addressOf(own(args, 'account') ?? client.account),
      to: typeof to === 'string' ? to : undefined,
      value: own(args, 'value') as SendInput['value'],
      nonce: own(args, 'nonce') as SendInput['nonce'],
    });

    /**
     * Logs that reading the call's arguments for telemetry threw, for example on a Proxy whose traps throw; the caller
     * then makes the call untraced, so the read never affects it.
     */
    const untraced = (error: unknown): void => {
      diag.error(
        `hashspan: failed to read the call arguments; call not traced (${errorName(error)})`,
      );
    };

    const actions: Partial<Record<TracedAction, AnyAction>> = {};
    const {
      sendTransaction,
      writeContract,
      waitForTransactionReceipt,
      sendUserOperation,
      waitForUserOperationReceipt,
      sendCalls,
      sendCallsSync,
      waitForCallsStatus,
    } = client;

    if (typeof sendTransaction === 'function') {
      actions.sendTransaction = (args: SendArgs) =>
        traceSend(
          transactionSend(args, (chainId) => ({
            ...sendInput(args, own(args, 'to') as string | undefined, chainId),
            functionSelector: selectorOf(own(args, 'data') as string | undefined),
          })),
          () => sendTransaction(args),
        );
    }

    if (typeof writeContract === 'function') {
      actions.writeContract = (args: WriteContractArgs) => {
        let functionName: string | undefined;
        let abi: Abi | undefined;
        let functionArguments: readonly unknown[] | undefined;
        try {
          functionName = own(args, 'functionName') as string | undefined;
          abi = abiForTelemetry(own(args, 'abi'), functionName);
          functionArguments = own(args, 'args') as readonly unknown[] | undefined;
        } catch (error) {
          untraced(error);
          return writeContract(args);
        }
        return traceSend(
          transactionSend(
            args,
            (chainId) => {
              let functionSelector: string | undefined;
              try {
                const item = getAbiItem({
                  abi,
                  name: functionName,
                  // Overload matching reads the arguments deeply: it gets a copy without accessors.
                  args: dataOnly(functionArguments, MAX_ARGUMENTS_COPY_DEPTH),
                } as never);
                functionSelector = item ? toFunctionSelector(item as never) : undefined;
              } catch {
                // Unknown or ambiguous ABI item: record the function name only.
              }
              return {
                ...sendInput(args, own(args, 'address') as string | undefined, chainId),
                functionName,
                functionSelector,
                functionArguments,
              };
            },
            abi,
          ),
          () => writeContract(args),
        );
      };
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

      /**
       * What tracing a wait needs, read without running a getter, or undefined when the wait is not traced: an
       * inherited hash, a hash or callback behind an accessor, or arguments that throw when read.
       */
      const prepareWait = (args: WaitArgs) => {
        try {
          const hash = own(args, 'hash');
          // viem reads the callback through the prototype chain as well.
          const onReplaced =
            args !== null && typeof args === 'object'
              ? descriptorOf(args, 'onReplaced')
              : undefined;
          if (typeof hash !== 'string' || (onReplaced !== undefined && !('value' in onReplaced))) {
            return undefined;
          }
          // Always wrapped, so that a replacement is attributed however the span is recorded (docs/adr/0008).
          const capture: ReplacementCapture = {};
          const waitArgs = shadowing(args, 'onReplaced', capturing(capture, onReplaced?.value));
          return { hash, chainId: knownChainId(args), capture, waitArgs };
        } catch (error) {
          untraced(error);
          return undefined;
        }
      };

      actions.waitForTransactionReceipt = async (args: WaitArgs) => {
        const prepared = prepareWait(args);
        if (!prepared) return waitForTransactionReceipt(args);
        const { hash, chainId, capture, waitArgs } = prepared;
        let handle: ConfirmHandle | undefined;
        if (chainId !== undefined) {
          try {
            handle = tracker.startConfirm({ chainId, hash });
          } catch (error) {
            diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
          }
        }
        const late =
          chainId === undefined
            ? { ctx: context.active(), startTime: new Date(), chainId: queryChainId() }
            : undefined;
        const wait = waitForTransactionReceipt(waitArgs) as Promise<ViemReceipt>;
        if (handle && chainId !== undefined) {
          track(recordConfirmation(chainId, hash, handle, wait, capture, client));
        } else if (late) {
          track(
            recordLateConfirmation(late.ctx, late.startTime, late.chainId, hash, wait, capture),
          );
        }
        return wait;
      };
    }

    /**
     * The chain of a bundler client: its own, else that of the client it was created with (`createBundlerClient`'s
     * `client`). viem's user operation actions take no `chain` argument.
     */
    const userOperationChainId = (): number | undefined => {
      const id = client.chain?.id ?? (client as { client?: ViemClientLike }).client?.chain?.id;
      return typeof id === 'number' ? id : undefined;
    };

    // Of the bundler actions, only these two: viem calls the others from inside them (prepareUserOperation,
    // getUserOperationReceipt), but nothing calls these two, so no operation is traced twice (docs/adr/0021).
    if (typeof sendUserOperation === 'function') {
      actions.sendUserOperation = (args: unknown) =>
        traceSend(
          {
            chainId: userOperationChainId,
            start: (chainId, startTime) => {
              const handle = tracker.startUserOperationSend({
                ...userOperationInput(args, chainId),
                ...(startTime !== undefined ? { startTime } : {}),
              });
              return {
                context: handle.context,
                end: (userOpHash, endTime) =>
                  handle.end({ userOpHash }, endTime !== undefined ? { endTime } : undefined),
                fail: (error, endTime) =>
                  handle.fail(error, endTime !== undefined ? { endTime } : undefined),
              };
            },
            after: () => {},
          },
          () => sendUserOperation(args),
        );
    }

    /** What the send span of `sendUserOperation(args)` records, read from own data properties only. */
    const userOperationInput = (args: unknown, chainId: number): UserOperationInput => {
      const account = own(args, 'account') ?? client.account;
      const entryPoint =
        own(args, 'entryPointAddress') ?? own(own(account, 'entryPoint'), 'address');
      const calls = own(args, 'calls');
      const callCount = Array.isArray(calls) ? own(calls, 'length') : undefined;
      // Without an account, the arguments are a complete user operation with its `sender`.
      const sender = addressOf(account) ?? own(args, 'sender');
      return {
        chainId,
        sender: typeof sender === 'string' ? sender : undefined,
        entryPoint: typeof entryPoint === 'string' ? entryPoint : undefined,
        callCount: typeof callCount === 'number' ? callCount : undefined,
      };
    };

    if (typeof waitForUserOperationReceipt === 'function') {
      /**
       * Ends `waitingHandle` from the outcome of `wait`; never rejects. Resolves as soon as the handle has ended,
       * including when a flush that gave up ended it.
       */
      const recordUserOperationReceipt = (
        waitingHandle: UserOperationConfirmHandle,
        wait: Promise<ViemUserOperationReceipt>,
        endTimeOf: () => TimeInput | undefined = () => undefined,
      ): Promise<void> => {
        const confirmation = settleOnce(waitingHandle);
        const { handle } = confirmation;
        const options = () => {
          const endTime = endTimeOf();
          return endTime !== undefined ? { endTime } : undefined;
        };
        const record = async (): Promise<void> => {
          let receipt: ViemUserOperationReceipt;
          try {
            receipt = await wait;
          } catch (error) {
            if (isUserOperationTimeout(error)) handle.timeout(options());
            else handle.fail(error, options());
            return;
          }
          try {
            handle.end(toUserOperationReceiptLike(receipt), options());
          } catch (error) {
            diag.error(`hashspan: failed to record user operation receipt (${errorName(error)})`);
            handle.fail(error, options());
          }
        };
        return Promise.race([record(), confirmation.ended]);
      };

      /** Records a wait whose chain id was unknown when it started, once it is known. Never rejects. */
      const recordLateUserOperationReceipt = async (
        ctx: Context,
        startTime: Date,
        chainId: Promise<number>,
        userOpHash: string,
        wait: Promise<ViemUserOperationReceipt>,
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
            tracker.startUserOperationConfirm({ chainId: id, userOpHash, startTime }),
          );
          await recordUserOperationReceipt(handle, wait, () => endTime ?? new Date());
        } catch (error) {
          diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
        }
      };

      actions.waitForUserOperationReceipt = (args: unknown) => {
        let userOpHash: unknown;
        let chainId: number | undefined;
        try {
          userOpHash = own(args, 'hash');
          chainId = userOperationChainId();
        } catch (error) {
          untraced(error);
          return waitForUserOperationReceipt(args);
        }
        if (typeof userOpHash !== 'string') return waitForUserOperationReceipt(args);
        let handle: UserOperationConfirmHandle | undefined;
        if (chainId !== undefined) {
          try {
            handle = tracker.startUserOperationConfirm({ chainId, userOpHash });
          } catch (error) {
            diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
          }
        }
        const late =
          chainId === undefined
            ? { ctx: context.active(), startTime: new Date(), chainId: queryChainId() }
            : undefined;
        // Called synchronously, as without hashspan; a synchronous throw becomes a rejection the handle records.
        const wait = (async () =>
          waitForUserOperationReceipt(args))() as Promise<ViemUserOperationReceipt>;
        if (handle) {
          track(recordUserOperationReceipt(handle, wait));
        } else if (late) {
          track(
            recordLateUserOperationReceipt(
              late.ctx,
              late.startTime,
              late.chainId,
              userOpHash,
              wait,
            ),
          );
        }
        return wait;
      };
    }

    // EIP-5792 call batches (docs/adr/0022-call-batches.md). getCallsStatus is not wrapped: waitForCallsStatus polls it.
    if (typeof sendCalls === 'function') {
      actions.sendCalls = (args: unknown) =>
        traceSend<unknown>(
          {
            chainId: () => knownChainId(args as SendArgs),
            start: (chainId, startTime) => {
              const handle = tracker.startCallBatchSend({
                ...callBatchInput(args, chainId),
                ...(startTime !== undefined ? { startTime } : {}),
              });
              return {
                context: handle.context,
                end: (result, endTime) => {
                  const id = callBatchIdOf(result) ?? '';
                  handle.end(
                    { id, transactionHashes: fallbackTransactionHashes(id) },
                    endTime !== undefined ? { endTime } : undefined,
                  );
                },
                fail: (error, endTime) =>
                  handle.fail(error, endTime !== undefined ? { endTime } : undefined),
              };
            },
            // The transactions of viem's fallback are the account's own: confirmed as transactions (ADR 0022).
            after: (chainId, result) => {
              const id = callBatchIdOf(result);
              for (const hash of (id && fallbackTransactionHashes(id)) || []) {
                afterSend(chainId, hash, undefined);
              }
            },
          },
          () => sendCalls(args),
        );
    }

    /** What the send span of `sendCalls(args)` records, read from own data properties only. */
    const callBatchInput = (args: unknown, chainId: number): CallBatchInput => {
      const calls = own(args, 'calls');
      const callCount = Array.isArray(calls) ? own(calls, 'length') : undefined;
      return {
        chainId,
        sender: addressOf(own(args, 'account') ?? client.account),
        callCount: typeof callCount === 'number' ? callCount : undefined,
      };
    };

    if (typeof waitForCallsStatus === 'function') {
      /**
       * Ends `waitingHandle` from the outcome of `wait`; never rejects. Resolves as soon as the handle has ended,
       * including when a flush that gave up ended it.
       */
      const recordCallBatchStatus = (
        waitingHandle: CallBatchConfirmHandle,
        wait: Promise<unknown>,
        endTimeOf: () => TimeInput | undefined = () => undefined,
      ): Promise<void> => {
        const confirmation = settleOnce(waitingHandle);
        const { handle } = confirmation;
        const options = () => {
          const endTime = endTimeOf();
          return endTime !== undefined ? { endTime } : undefined;
        };
        const record = async (): Promise<void> => {
          let status: unknown;
          try {
            status = await wait;
          } catch (error) {
            // With throwOnFailure, a failed batch rejects with its status: recorded as that status.
            if (error instanceof Error && error.name === 'BundleFailedError') {
              status = own(error, 'result');
            } else {
              if (isCallsTimeout(error)) handle.timeout(options());
              else handle.fail(error, options());
              return;
            }
          }
          try {
            handle.end(toCallBatchStatusLike(status), options());
          } catch (error) {
            diag.error(`hashspan: failed to record call batch status (${errorName(error)})`);
            handle.fail(error, options());
          }
        };
        return Promise.race([record(), confirmation.ended]);
      };

      /** Records a wait whose chain id was unknown when it started, once it is known. Never rejects. */
      const recordLateCallBatchStatus = async (
        ctx: Context,
        startTime: Date,
        id: string,
        wait: Promise<unknown>,
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
        // The status names its chain; without one, the client is asked once the wait has settled.
        const chainId = wait.then(
          (status) => {
            const reported = own(status, 'chainId');
            return typeof reported === 'number' ? reported : queryChainId();
          },
          () => queryChainId(),
        );
        const known = await chainIdOrGiveUp(chainId, settled);
        if (known === undefined) return;
        try {
          const handle = context.with(ctx, () =>
            tracker.startCallBatchConfirm({ chainId: known, id, startTime }),
          );
          await recordCallBatchStatus(handle, wait, () => endTime ?? new Date());
        } catch (error) {
          diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
        }
      };

      actions.waitForCallsStatus = (args: unknown) => {
        let id: unknown;
        let chainId: number | undefined;
        try {
          id = own(args, 'id');
          chainId = client.chain?.id;
        } catch (error) {
          untraced(error);
          return waitForCallsStatus(args);
        }
        if (typeof id !== 'string') return waitForCallsStatus(args);
        let handle: CallBatchConfirmHandle | undefined;
        if (chainId !== undefined) {
          try {
            handle = tracker.startCallBatchConfirm({ chainId, id });
          } catch (error) {
            diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
          }
        }
        const late =
          chainId === undefined ? { ctx: context.active(), startTime: new Date() } : undefined;
        // Called synchronously, as without hashspan; a synchronous throw becomes a rejection the handle records.
        const wait = (async () => waitForCallsStatus(args))() as Promise<unknown>;
        if (handle) track(recordCallBatchStatus(handle, wait));
        else if (late) track(recordLateCallBatchStatus(late.ctx, late.startTime, id, wait));
        return wait;
      };
    }

    // viem's sendCallsSync calls sendCalls and waitForCallsStatus of the client it gets, so it runs here with the
    // traced ones: one send span and one confirm span, with viem's own logic (docs/adr/0022-call-batches.md).
    const viemSendCallsSync: unknown = (viemActions as Record<string, unknown>).sendCallsSync;
    if (
      typeof sendCallsSync === 'function' &&
      typeof viemSendCallsSync === 'function' &&
      actions.sendCalls &&
      actions.waitForCallsStatus
    ) {
      const traced = {
        ...client,
        sendCalls: actions.sendCalls,
        waitForCallsStatus: actions.waitForCallsStatus,
      };
      actions.sendCallsSync = (args: unknown) =>
        (viemSendCallsSync as (client: unknown, args: unknown) => Promise<unknown>)(traced, args);
    }

    return actions;
  };

  return Object.assign(extension, { flush, watch }) as HashspanExtension;
}
