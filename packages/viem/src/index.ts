import { createTxTracker, type TxTracker, type TxTrackerOptions } from '@hashspan/core';
import type { Abi } from 'viem';
import { own } from './arguments.js';
import { addCallBatchActions } from './call-batch.js';
import { createConfirmation } from './confirm/confirmation.js';
import { createPending } from './confirm/pending.js';
import { Recent } from './confirm/recent.js';
import { durationOr } from './confirm/timing.js';
import { createWatch } from './confirm/watch.js';
import { guardTracker } from './safe-tracker.js';
import { createSendTracing } from './send.js';
import { addTransactionActions } from './transaction.js';
import type {
  AnyAction,
  BackgroundConfirmOptions,
  FlushOptions,
  TracedAction,
  ViemClientLike,
  WatchOptions,
} from './types.js';
import { addUserOperationActions } from './user-operation.js';

export { type TraceTransportOptions, traceTransport } from './transport.js';
export type {
  BackgroundConfirmOptions,
  FlushOptions,
  TracedAction,
  ViemClientLike,
  WatchOptions,
} from './types.js';

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
   * Replay reverted transactions to record their revert reason (two extra RPC requests per reverted transaction, three
   * when the first replay does not revert).
   * `{ timeoutMs }` bounds the replay; if the provider has not answered by then, the receipt is recorded without a
   * reason. Default: true, with a 10 000 ms bound. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.10.0/docs/adr/0005-revert-reason-replay.md.
   */
  decodeRevertReason?: boolean | { timeoutMs?: number | undefined } | undefined;
  /**
   * Most background confirmations (`confirm: { mode: 'background' }` and `watch()`) polling at once. A transaction
   * sent while that many are polling gets no background confirm span, and a `diag` warning is logged; waits of the
   * caller are not counted and always traced. Default: 256. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.10.0/docs/adr/0018-background-confirmation-limit.md.
   */
  maxBackgroundConfirmations?: number | undefined;
}

const DEFAULT_MAX_BACKGROUND_CONFIRMATIONS = 256;
const DEFAULT_REVERT_REASON_TIMEOUT_MS = 10_000;

/** Client extension returned by {@link withHashspan}: the traced actions present on the client. */
export interface HashspanExtension {
  <TClient extends ViemClientLike>(
    client: TClient,
  ): Pick<TClient, Extract<keyof TClient, TracedAction>>;
  /**
   * Waits for tracing work still running after traced calls returned (background confirmations, revert reason
   * replays, calls recorded once their chain id is known), so their spans are ended before the OpenTelemetry SDK
   * shuts down. Resolves true when all of it finished, false on timeout; never rejects. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.10.0/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
  /**
   * Confirms a transaction sent outside the extended clients (for example by a wallet API) through `client`, in the
   * background: a confirm span with the receipt, revert reason and fees, linked to the send span when the same
   * tracker recorded one. Never throws and never waits; `flush()` awaits it. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.10.0/docs/adr/0012-cdp-adapter.md.
   */
  watch(client: ViemClientLike, options: WatchOptions): void;
}

/** The `timeoutMs` of the `decodeRevertReason` option, read from an own data property and never throwing. */
function revertReasonTimeoutOf(option: unknown): number {
  try {
    return durationOr(own(option, 'timeoutMs'), DEFAULT_REVERT_REASON_TIMEOUT_MS);
  } catch {
    return DEFAULT_REVERT_REASON_TIMEOUT_MS;
  }
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
  // Guarded so that no tracker, including a user-provided one, can throw into the instrumented call.
  const decodeRevertReason = decodeRevertReasonOption !== false;
  const revertReasonTimeoutMs = revertReasonTimeoutOf(decodeRevertReasonOption);
  const tracker = guardTracker(providedTracker ?? createTxTracker(trackerOptions));
  /** ABIs of recent `writeContract` calls, to decode custom errors. */
  const abis = new Recent<Abi>();
  /** Revert reasons being or already fetched, so concurrent waits for one transaction fetch it once. */
  const revertReasons = new Recent<Promise<string | undefined>>();
  const { track, flush, settleOnce } = createPending();
  const { recordConfirmation, confirmThrough } = createConfirmation({
    tracker,
    decodeRevertReason,
    revertReasonTimeoutMs,
    maxBackgroundConfirmations,
    abis,
    revertReasons,
    track,
    settleOnce,
  });
  const watch = createWatch({ abis, confirmThrough, track });

  const extension = (client: ViemClientLike & Partial<Record<TracedAction, AnyAction>>) => {
    const sending = createSendTracing(client, track);
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
    addTransactionActions(
      client,
      { sendTransaction, writeContract, waitForTransactionReceipt },
      actions,
      { tracker, confirm, abis, track, recordConfirmation, confirmThrough, sending },
    );
    addUserOperationActions(client, { sendUserOperation, waitForUserOperationReceipt }, actions, {
      tracker,
      track,
      settleOnce,
      sending,
    });
    addCallBatchActions(client, { sendCalls, sendCallsSync, waitForCallsStatus }, actions, {
      tracker,
      confirm,
      track,
      settleOnce,
      confirmThrough,
      sending,
    });
    return actions;
  };

  return Object.assign(extension, { flush, watch }) as HashspanExtension;
}
