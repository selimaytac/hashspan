import {
  type Attributes,
  type Context,
  context,
  diag,
  SpanKind,
  type TimeInput,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_BLOCKCHAIN_BLOCK_NUMBER,
  ATTR_BLOCKCHAIN_CALL_BATCH_ATOMIC,
  ATTR_BLOCKCHAIN_CALL_BATCH_CALL_COUNT,
  ATTR_BLOCKCHAIN_CALL_BATCH_ID,
  ATTR_BLOCKCHAIN_CALL_BATCH_SENDER,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS_CODE,
  ATTR_BLOCKCHAIN_CALL_BATCH_TRANSACTION_HASHES,
  ATTR_BLOCKCHAIN_OPERATION_SUBJECT,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_SUCCESS,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_OPERATION_SUBJECT_VALUE_CALL_BATCH,
  ERROR_TYPE_VALUE_OTHER,
} from './attributes.js';
import { ConfirmRegistry, type SharedConfirm } from './confirm-registry.js';
import { LinkStore } from './link-store.js';
import { createTxMetrics, toEpochMs } from './metrics.js';
import {
  type AddressFormatter,
  OFF_ADDRESS_FORMATTER,
  resolveAddressFormatter,
  resolveErrorMessageMode,
  resolvePaymentResourceMode,
} from './privacy.js';
import { joinConfirm } from './tracker/confirm-claim.js';
import {
  errorType,
  type HandleOptions,
  handleOptions,
  OBSERVER_TIMEOUT,
  reportedErrorType,
  safely,
} from './tracker/handles.js';
import { createPaymentSpans, NOOP_PAYMENT } from './tracker/payment.js';
import { createSpanRecording, metricAttributes, secondsSince } from './tracker/spans.js';
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
import { smallQuantity, TX_HASH } from './tracker/values.js';
import type {
  CallBatchConfirmHandle,
  CallBatchConfirmInput,
  CallBatchInput,
  CallBatchSendHandle,
  CallBatchStatusLike,
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

/** `error.type` of a call batch that failed without being included (EIP-5792 status 400). */
const CALL_BATCH_FAILED = 'failed';
/** A call batch id: `0x`-prefixed hex of at most 8194 characters, the bound EIP-5792 sets. */
const CALL_BATCH_ID = /^0x[0-9a-fA-F]{1,8192}$/;
/** Longest call batch id recorded as an attribute. */
const MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH = 256;
/** Most transaction hashes recorded for one call batch. */
const MAX_CALL_BATCH_TRANSACTION_HASHES = 64;

/** EIP-5792 status code of a batch that is still pending. */
const CALL_BATCH_PENDING = 100;

const noopCallBatchSend = (parent: Context): CallBatchSendHandle => ({
  context: parent,
  end: () => {},
  fail: () => {},
});
const NOOP_CALL_BATCH_CONFIRM: CallBatchConfirmHandle = {
  end: () => {},
  timeout: () => {},
  fail: () => {},
};

/** The confirm span of one call batch and how to end it; shared by all its handles. */
interface CallBatchConfirmSpan extends SharedConfirm {
  status(status: CallBatchStatusLike, endTime?: TimeInput): void;
  timeout(endTime?: TimeInput): void;
  fail(error: unknown, options: HandleOptions): void;
}

/** A call batch id the tracker keys and records. */
function isCallBatchId(id: unknown): id is string {
  return typeof id === 'string' && CALL_BATCH_ID.test(id);
}

/** Whether `status` says the batch is still pending: its wait resolved before an outcome. */
function isPendingCallBatch(status: CallBatchStatusLike | null | undefined): boolean {
  return status?.statusCode === CALL_BATCH_PENDING;
}

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
  /** Metric attributes of a call batch sample. */
  const callBatchMetricAttributes = (chainId: number, extra: Attributes = {}): Attributes =>
    metricAttributes(chainId, {
      [ATTR_BLOCKCHAIN_OPERATION_SUBJECT]: BLOCKCHAIN_OPERATION_SUBJECT_VALUE_CALL_BATCH,
      ...extra,
    });
  let tracer: Tracer | undefined;
  const getTracer = (): Tracer => {
    tracer ??= (options.tracerProvider ?? trace.getTracerProvider()).getTracer(
      INSTRUMENTATION_NAME,
      VERSION,
    );
    return tracer;
  };
  const recording = createSpanRecording({ options, formatAddress, errorMessages });
  const { redact, markError, finisher, setRemoteAddress, baseAttributes } = recording;
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

  const startCallBatchSend = (input: CallBatchInput, parentCtx?: Context): CallBatchSendHandle => {
    const parent = parentCtx ?? context.active();
    const { chainId } = input;
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_CALL_BATCH_SENDER, input.sender);
    const callCount = smallQuantity(input.callCount);
    if (callCount !== undefined) attributes[ATTR_BLOCKCHAIN_CALL_BATCH_CALL_COUNT] = callCount;

    const span = getTracer().startSpan(
      `send ${chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      },
      parent,
    );
    const finish = finisher(span);
    const startMs = toEpochMs(input.startTime);
    const recordSend = (endTime: TimeInput | undefined, errorType?: string): void =>
      txMetrics.sendDuration(
        secondsSince(startMs, endTime),
        callBatchMetricAttributes(
          chainId,
          errorType === undefined ? {} : { [ATTR_ERROR_TYPE]: errorType },
        ),
      );

    return {
      context: trace.setSpan(parent, span),
      end: (result, second) => {
        const { endTime } = handleOptions(second);
        finish(
          'record call batch id',
          () => {
            const id: unknown = result?.id;
            // The id comes from the wallet: validated before it is recorded or used as a key.
            if (!isCallBatchId(id)) {
              diag.debug('hashspan: ending a send span without a valid call batch id');
              return;
            }
            const sent = { spanContext: span.spanContext(), parent };
            callBatchLinks.set(chainId, id, sent);
            // Transactions the account sent itself for the batch are linked like those of a send span.
            const hashes: unknown = result.transactionHashes;
            if (Array.isArray(hashes)) {
              for (const hash of hashes) {
                if (typeof hash === 'string' && TX_HASH.test(hash) && !/^0x0+$/.test(hash)) {
                  links.set(chainId, hash, sent);
                }
              }
            }
            span.setAttributes(
              redact({
                [ATTR_BLOCKCHAIN_CALL_BATCH_ID]: id.slice(0, MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH),
              }),
            );
            recordSend(endTime);
          },
          endTime,
        );
      },
      fail: (error, second) => {
        const read = handleOptions(second);
        finish(
          'record call batch send failure',
          () =>
            recordSend(
              read.endTime,
              markError(span, reportedErrorType(error, read), error, errorType(error)),
            ),
          read.endTime,
        );
      },
    };
  };

  /** Attributes of a call batch status. Its values come from a wallet: what is malformed is left out. */
  const callBatchStatusAttributes = (status: CallBatchStatusLike): Attributes => {
    const attributes: Attributes = {};
    const code = smallQuantity(status.statusCode);
    if (code !== undefined) attributes[ATTR_BLOCKCHAIN_CALL_BATCH_STATUS_CODE] = code;
    const atomic: unknown = status.atomic;
    if (typeof atomic === 'boolean') attributes[ATTR_BLOCKCHAIN_CALL_BATCH_ATOMIC] = atomic;
    const receipts: unknown = status.receipts;
    if (Array.isArray(receipts)) {
      const hashes: string[] = [];
      const seen = new Set<string>();
      let block: number | undefined;
      for (const receipt of receipts) {
        const hash: unknown = receipt?.transactionHash;
        // Some wallets repeat one receipt per call: each transaction is recorded once, up to a bound.
        if (
          typeof hash === 'string' &&
          TX_HASH.test(hash) &&
          !seen.has(hash.toLowerCase()) &&
          hashes.length < MAX_CALL_BATCH_TRANSACTION_HASHES
        ) {
          seen.add(hash.toLowerCase());
          hashes.push(hash);
        }
        const number = smallQuantity(receipt?.blockNumber);
        if (number !== undefined && (block === undefined || number > block)) block = number;
      }
      if (hashes.length > 0) attributes[ATTR_BLOCKCHAIN_CALL_BATCH_TRANSACTION_HASHES] = hashes;
      if (block !== undefined) attributes[ATTR_BLOCKCHAIN_BLOCK_NUMBER] = block;
    }
    return attributes;
  };

  /**
   * The outcome of an EIP-5792 status code (ADR 0022): `blockchain.call_batch.status` for outcomes from chain data,
   * `error.type` for the rest; a code the spec does not define, or none, is `_OTHER`.
   */
  const callBatchOutcome = (code: unknown): { status?: string; errorType?: string } => {
    switch (code) {
      case 200:
        return { status: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_SUCCESS };
      case 400:
        return { errorType: CALL_BATCH_FAILED };
      case 500:
        return {
          status: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
          errorType: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
        };
      case 600:
        return {
          status: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
          errorType: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
        };
      default:
        return { errorType: ERROR_TYPE_VALUE_OTHER };
    }
  };

  /** Opens the confirm span of a call batch. */
  const openCallBatchConfirm = (
    input: CallBatchConfirmInput,
    parentCtx?: Context,
  ): CallBatchConfirmSpan => {
    const { chainId, id } = input;
    const sent = callBatchLinks.get(chainId, id);
    const active = context.active();
    const parent = parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM, parent);
    attributes[ATTR_BLOCKCHAIN_CALL_BATCH_ID] = id.slice(0, MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH);
    const span = getTracer().startSpan(
      `confirm ${chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        links: sent ? [{ context: sent.spanContext }] : [],
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      },
      parent,
    );
    const finish = finisher(span);
    const startMs = toEpochMs(input.startTime);
    const recordConfirmation = (endTime: TimeInput | undefined, outcome: Attributes): void =>
      txMetrics.confirmationDuration(
        secondsSince(startMs, endTime),
        callBatchMetricAttributes(chainId, outcome),
      );

    return {
      active: 0,
      ended: false,
      status: (status, endTime) =>
        finish(
          'record call batch status',
          () => {
            const attributes = callBatchStatusAttributes(status ?? {});
            // A wait that resolved while the batch is pending has no outcome yet: no metric sample (ADR 0022).
            if (isPendingCallBatch(status)) {
              span.setAttributes(redact(attributes));
              return;
            }
            const outcome = callBatchOutcome(status?.statusCode);
            if (outcome.status !== undefined) {
              attributes[ATTR_BLOCKCHAIN_CALL_BATCH_STATUS] = outcome.status;
            }
            span.setAttributes(redact(attributes));
            if (outcome.errorType !== undefined) markError(span, outcome.errorType);
            // The outcome from chain data is the batch status; raw codes never become metric attributes. Batches
            // record no fee: wallet receipts lack the L1 fee and can be a bundle shared with others (ADR 0022).
            recordConfirmation(
              endTime,
              outcome.status !== undefined
                ? { [ATTR_BLOCKCHAIN_CALL_BATCH_STATUS]: outcome.status }
                : { [ATTR_ERROR_TYPE]: outcome.errorType },
            );
          },
          endTime,
        ),
      timeout: (endTime) =>
        finish(
          'record call batch confirmation timeout',
          () =>
            recordConfirmation(endTime, { [ATTR_ERROR_TYPE]: markError(span, OBSERVER_TIMEOUT) }),
          endTime,
        ),
      fail: (error, read) =>
        finish(
          'record call batch confirmation failure',
          () =>
            recordConfirmation(read.endTime, {
              [ATTR_ERROR_TYPE]: markError(
                span,
                reportedErrorType(error, read),
                error,
                errorType(error),
              ),
            }),
          read.endTime,
        ),
    };
  };

  const startCallBatchConfirm = (
    input: CallBatchConfirmInput,
    parentCtx?: Context,
  ): CallBatchConfirmHandle => {
    const { chainId, id } = input;
    if (!isCallBatchId(id)) {
      diag.debug('hashspan: not confirming a call batch without a valid id');
      return NOOP_CALL_BATCH_CONFIRM;
    }
    const claim = joinConfirm(callBatchConfirmations, chainId, id, () =>
      openCallBatchConfirm(input, parentCtx),
    );
    if (!claim) return NOOP_CALL_BATCH_CONFIRM;
    const { shared } = claim;
    return {
      end: (status, second) => {
        const { endTime } = handleOptions(second);
        // A pending result is an observer outcome, like a timeout: it withdraws this wait, and ends the span only as
        // the last one still waiting, releasing the key for a later wait (ADR 0007, ADR 0016).
        if (isPendingCallBatch(status)) {
          claim.withdraw(() => shared.status(status, endTime));
          return;
        }
        if (!claim.receive()) return;
        callBatchConfirmations.settle(chainId, id, shared);
        shared.status(status, endTime);
      },
      timeout: (second) => {
        const { endTime } = handleOptions(second);
        claim.withdraw(() => shared.timeout(endTime));
      },
      fail: (error, second) => {
        const read = handleOptions(second);
        claim.withdraw(() => shared.fail(error, read));
      },
    };
  };

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
