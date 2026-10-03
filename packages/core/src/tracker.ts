import { type Context, context, type Tracer, trace } from '@opentelemetry/api';
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
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0014-core-api-boundary.md).
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0013-x402-payments.md). Call
   * `end(settlement)` with the settlement, or `fail(error)`. A settlement with a hash links the transaction's confirm
   * span to this span, as a send span would.
   */
  startPayment(input: PaymentInput, parent?: Context): PaymentHandle;
  /**
   * Starts a `send` span for a user operation of a smart account as a child of `parent` (default: the active context)
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0021-user-operations.md). Call
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0022-call-batches.md). Call
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
 * `@opentelemetry/api` (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/semconv.md). It makes
 * no network calls; the caller passes hashes and receipts. Its methods and handles never throw: failures are logged
 * via `diag`, and a method that fails returns a handle that records nothing.
 */
export function createTxTracker(options: TxTrackerOptions = {}): TxTracker {
  const links = new LinkStore({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
  const confirmations = new ConfirmRegistry<ConfirmSpan>({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
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
  const userOperationLinks = new LinkStore({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
  const userOperationConfirmations = new ConfirmRegistry<UserOperationConfirmSpan>({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
  // Call batches have a third key space (docs/adr/0022-call-batches.md), with the same bounds.
  const callBatchLinks = new LinkStore({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
  const callBatchConfirmations = new ConfirmRegistry<CallBatchConfirmSpan>({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
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

  return {
    startSend: (input, parent) =>
      safely(
        'start send span',
        () => startSend(input, parent),
        noopSend(parent ?? context.active()),
      ),
    startConfirm: (input, parent) =>
      safely('start confirm span', () => startConfirm(input, parent), NOOP_CONFIRM),
    startPayment: (input, parent) =>
      safely('start payment span', () => startPayment(input, parent), NOOP_PAYMENT),
    startUserOperationSend: (input, parent) =>
      safely(
        'start user operation send span',
        () => startUserOperationSend(input, parent),
        noopUserOperationSend(parent ?? context.active()),
      ),
    startUserOperationConfirm: (input, parent) =>
      safely(
        'start user operation confirm span',
        () => startUserOperationConfirm(input, parent),
        NOOP_USER_OPERATION_CONFIRM,
      ),
    startCallBatchSend: (input, parent) =>
      safely(
        'start call batch send span',
        () => startCallBatchSend(input, parent),
        noopCallBatchSend(parent ?? context.active()),
      ),
    startCallBatchConfirm: (input, parent) =>
      safely(
        'start call batch confirm span',
        () => startCallBatchConfirm(input, parent),
        NOOP_CALL_BATCH_CONFIRM,
      ),
  };
}
