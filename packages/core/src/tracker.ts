import { type Context, context, diag, type Tracer, trace } from '@opentelemetry/api';
import { ConfirmRegistry } from './confirm-registry.js';
import { LinkStore } from './link-store.js';
import { createTxMetrics } from './metrics.js';
import {
  type AddressFormatter,
  OFF_ADDRESS_FORMATTER,
  resolveAddressFormatter,
  resolveErrorMessageMode,
  resolvePaymentResourceMode,
} from './privacy.js';
import {
  type CallBatchConfirmSpan,
  createCallBatchSpans,
  NOOP_CALL_BATCH_CONFIRM,
  noopCallBatchSend,
} from './tracker/call-batch.js';
import { safely } from './tracker/handles.js';
import { createPaymentSpans, NOOP_PAYMENT } from './tracker/payment.js';
import { createSpanRecording } from './tracker/spans.js';
import {
  type ConfirmSpan,
  createTransactionSpans,
  NOOP_CONFIRM,
  noopSend,
} from './tracker/transaction.js';
import {
  createUserOperationSpans,
  NOOP_USER_OPERATION_CONFIRM,
  noopUserOperationSend,
  type UserOperationConfirmSpan,
} from './tracker/user-operation.js';
import { isChainId } from './tracker/values.js';
import type {
  CallBatchConfirmHandle,
  CallBatchConfirmInput,
  CallBatchInput,
  CallBatchSendHandle,
  ConfirmHandle,
  ConfirmInput,
  PaymentHandle,
  PaymentInput,
  SendHandle,
  SendInput,
  TxTrackerOptions,
  UserOperationConfirmHandle,
  UserOperationConfirmInput,
  UserOperationInput,
  UserOperationSendHandle,
} from './types.js';
import { VERSION } from './version.js';

const INSTRUMENTATION_NAME = '@hashspan/core';
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 10_000;

/**
 * Records transactions, payments and user operations as spans. Obtain one from {@link createTxTracker}: it is not meant to be
 * implemented, and members may be added to it and to its handles in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface TxTracker {
  /**
   * Starts a `send` span as a child of `parent` (default: the active context).
   * Call `end({ hash })` once the transaction hash is known, or `fail(error)`.
   */
  startSend(input: SendInput, parent?: Context): SendHandle;
  /**
   * Joins the `confirm` span of a transaction, starting it for the first caller; linked to its `send` span when
   * known. Calls for the same chain id and hash share one span, whose parent is chosen by the first call:
   * `parent` if given, else the active span, else the `send` span's parent. Returns a no-op handle for a
   * transaction that recently got a receipt. Every returned handle must be ended.
   */
  startConfirm(input: ConfirmInput, parent?: Context): ConfirmHandle;
  /**
   * Starts a `payment` span as a child of `parent` (default: the active context), for a payment that another party
   * settles on chain
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0013-x402-payments.md). Call
   * `end(settlement)` with the settlement, or `fail(error)`. A settlement with a hash links the transaction's confirm
   * span to this span, as a send span would.
   */
  startPayment(input: PaymentInput, parent?: Context): PaymentHandle;
  /**
   * Starts a `send` span for a user operation of a smart account as a child of `parent` (default: the active context)
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0021-user-operations.md). Call
   * `end({ userOpHash })` once the bundler returned the operation's hash, or `fail(error)`.
   */
  startUserOperationSend(input: UserOperationInput, parent?: Context): UserOperationSendHandle;
  /**
   * Joins the `confirm` span of a user operation, starting it for the first caller; linked to its `send` span when
   * known. As for {@link TxTracker.startConfirm}, calls for the same chain id and user operation hash share one span,
   * apart from those of transactions. Returns a no-op handle for an operation that recently got a receipt. Every
   * returned handle must be ended.
   */
  startUserOperationConfirm(
    input: UserOperationConfirmInput,
    parent?: Context,
  ): UserOperationConfirmHandle;
  /**
   * Starts a `send` span for an EIP-5792 call batch as a child of `parent` (default: the active context)
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0022-call-batches.md). Call
   * `end({ id })` once the wallet returned the batch id, or `fail(error)`.
   */
  startCallBatchSend(input: CallBatchInput, parent?: Context): CallBatchSendHandle;
  /**
   * Joins the `confirm` span of a call batch, starting it for the first caller; linked to its `send` span when
   * known. As for {@link TxTracker.startConfirm}, calls for the same chain id and batch id share one span, apart from
   * those of transactions and user operations. Returns a no-op handle for a batch that recently got its status. Every
   * returned handle must be ended.
   */
  startCallBatchConfirm(input: CallBatchConfirmInput, parent?: Context): CallBatchConfirmHandle;
}

/**
 * Creates a tracker that records transactions as `send` and `confirm` spans, and payments as `payment` spans, with
 * `@opentelemetry/api` (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/semconv.md). It makes
 * no network calls; the caller passes hashes and receipts. Its methods and handles never throw: failures are logged
 * via `diag`, and a method that fails returns a handle that records nothing.
 */
export function createTxTracker(given: TxTrackerOptions = {}): TxTracker {
  const options = readOptions(given);
  const bounds = {
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  };
  const links = new LinkStore(bounds);
  const confirmations = new ConfirmRegistry<ConfirmSpan>(bounds);
  const formatAddress: AddressFormatter = safely(
    'configure address mode',
    () => resolveAddressFormatter(options.address),
    OFF_ADDRESS_FORMATTER,
  );
  const errorMessages = safely(
    'configure error message mode',
    () => resolveErrorMessageMode(options.errorMessages),
    'off',
  );
  const paymentResource = safely(
    'configure payment resource mode',
    () => resolvePaymentResourceMode(options.paymentResource),
    'off',
  );
  // User operations have their own key space (docs/adr/0021-user-operations.md), with the same bounds.
  const userOperationLinks = new LinkStore(bounds);
  const userOperationConfirmations = new ConfirmRegistry<UserOperationConfirmSpan>(bounds);
  // Call batches have a third key space (docs/adr/0022-call-batches.md), with the same bounds.
  const callBatchLinks = new LinkStore(bounds);
  const callBatchConfirmations = new ConfirmRegistry<CallBatchConfirmSpan>(bounds);
  const txMetrics = createTxMetrics(options.meterProvider, INSTRUMENTATION_NAME, VERSION);
  let tracer: Tracer | undefined;
  const getTracer = (): Tracer => {
    tracer ??= (options.tracerProvider ?? trace.getTracerProvider()).getTracer(
      INSTRUMENTATION_NAME,
      VERSION,
    );
    return tracer;
  };
  const recording = createSpanRecording({ options, formatAddress, errorMessages });
  const { startSend, startConfirm } = createTransactionSpans({
    options,
    links,
    confirmations,
    txMetrics,
    formatAddress,
    getTracer,
    recording,
  });
  const { startPayment } = createPaymentSpans({
    links,
    formatAddress,
    paymentResource,
    getTracer,
    recording,
  });
  const { startUserOperationSend, startUserOperationConfirm } = createUserOperationSpans({
    userOperationLinks,
    userOperationConfirmations,
    txMetrics,
    formatAddress,
    getTracer,
    recording,
  });
  const { startCallBatchSend, startCallBatchConfirm } = createCallBatchSpans({
    links,
    callBatchLinks,
    callBatchConfirmations,
    txMetrics,
    getTracer,
    recording,
  });

  /**
   * Starts a span with `start`, or returns `noop` when the input names no valid chain id: the chain id is in the span
   * name and a metric label, so a call without one records nothing (ADR 0025 rule 3).
   */
  const started = <I, H>(
    what: string,
    start: (input: I, parent?: Context) => H,
    noop: () => H,
  ): ((input: I, parent?: Context) => H) => {
    return (input, parent) =>
      safely(
        `start ${what} span`,
        () => {
          if (!isChainId((input as { chainId?: unknown } | undefined)?.chainId)) {
            diag.debug(`hashspan: not recording a ${what} without a valid chain id`);
            return noop();
          }
          return start(input, parent);
        },
        noop(),
      );
  };
  const parentOf = (parent?: Context): Context => parent ?? context.active();

  return {
    startSend: (input, parent) =>
      started('send', startSend, () => noopSend(parentOf(parent)))(input, parent),
    startConfirm: started('confirm', startConfirm, () => NOOP_CONFIRM),
    startPayment: started('payment', startPayment, () => NOOP_PAYMENT),
    startUserOperationSend: (input, parent) =>
      started('user operation send', startUserOperationSend, () =>
        noopUserOperationSend(parentOf(parent)),
      )(input, parent),
    startUserOperationConfirm: started(
      'user operation confirm',
      startUserOperationConfirm,
      () => NOOP_USER_OPERATION_CONFIRM,
    ),
    startCallBatchSend: (input, parent) =>
      started('call batch send', startCallBatchSend, () => noopCallBatchSend(parentOf(parent)))(
        input,
        parent,
      ),
    startCallBatchConfirm: started(
      'call batch confirm',
      startCallBatchConfirm,
      () => NOOP_CALL_BATCH_CONFIRM,
    ),
  };
}

/** The options `createTxTracker()` reads, each once. */
const OPTION_KEYS = [
  'tracerProvider',
  'meterProvider',
  'address',
  'errorMessages',
  'paymentResource',
  'recordFunctionArguments',
  'agent',
  'agentFromBaggage',
  'redact',
  'linkTtlMs',
  'maxTrackedTransactions',
] as const satisfies readonly (keyof TxTrackerOptions)[];

/**
 * A copy of `given` with each option read once, guarded: options that cannot be read are left at their default, and
 * so are bounds that are not positive numbers (ADR 0025). Never throws.
 */
function readOptions(given: unknown): TxTrackerOptions {
  const options: Record<string, unknown> = {};
  if ((typeof given !== 'object' && typeof given !== 'function') || given === null) {
    if (given !== undefined)
      diag.warn('hashspan: tracker options must be an object; using defaults');
    return options;
  }
  for (const key of OPTION_KEYS) {
    try {
      const value: unknown = (given as Record<string, unknown>)[key];
      if (value !== undefined) options[key] = value;
    } catch {
      diag.warn(`hashspan: could not read the ${key} option; using its default`);
    }
  }
  const ttl = options.linkTtlMs;
  if (ttl !== undefined && !(typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0)) {
    diag.warn('hashspan: linkTtlMs must be a positive number; using its default');
    delete options.linkTtlMs;
  }
  const max = options.maxTrackedTransactions;
  if (max !== undefined && !(typeof max === 'number' && Number.isSafeInteger(max) && max > 0)) {
    diag.warn('hashspan: maxTrackedTransactions must be a positive integer; using its default');
    delete options.maxTrackedTransactions;
  }
  return options as TxTrackerOptions;
}
