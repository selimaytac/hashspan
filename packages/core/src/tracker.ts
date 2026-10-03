import {
  type Attributes,
  type Context,
  context,
  diag,
  type Link,
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
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR,
  ATTR_BLOCKCHAIN_OPERATION_SUBJECT,
  ATTR_BLOCKCHAIN_PAYMENT_AMOUNT,
  ATTR_BLOCKCHAIN_PAYMENT_ASSET,
  ATTR_BLOCKCHAIN_PAYMENT_PAYER,
  ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL,
  ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT,
  ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT,
  ATTR_BLOCKCHAIN_PAYMENT_STATUS,
  ATTR_BLOCKCHAIN_PAYMENT_VERIFIED,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT,
  ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE,
  ATTR_BLOCKCHAIN_TX_FEE,
  ATTR_BLOCKCHAIN_TX_FROM,
  ATTR_BLOCKCHAIN_TX_GAS_USED,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_L1_FEE,
  ATTR_BLOCKCHAIN_TX_NONCE,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON,
  ATTR_BLOCKCHAIN_TX_REVERT_REASON,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_TX_TO,
  ATTR_BLOCKCHAIN_TX_VALUE,
  ATTR_BLOCKCHAIN_USER_OPERATION_CALL_COUNT,
  ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT,
  ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST,
  ATTR_BLOCKCHAIN_USER_OPERATION_GAS_USED,
  ATTR_BLOCKCHAIN_USER_OPERATION_HASH,
  ATTR_BLOCKCHAIN_USER_OPERATION_NONCE,
  ATTR_BLOCKCHAIN_USER_OPERATION_PAYMASTER,
  ATTR_BLOCKCHAIN_USER_OPERATION_SENDER,
  ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS,
  ATTR_ERROR_TYPE,
  ATTR_X402_RESOURCE,
  ATTR_X402_SCHEME,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_SUCCESS,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_OPERATION_SUBJECT_VALUE_CALL_BATCH,
  BLOCKCHAIN_OPERATION_SUBJECT_VALUE_USER_OPERATION,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_CANCELLED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPLACED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPRICED,
  BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
  BLOCKCHAIN_TX_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
  ERROR_TYPE_VALUE_OTHER,
} from './attributes.js';
import { ConfirmRegistry, type SharedConfirm } from './confirm-registry.js';
import { LinkStore } from './link-store.js';
import { createTxMetrics, toEpochMs } from './metrics.js';
import {
  type AddressFormatter,
  formatAddressesIn,
  OFF_ADDRESS_FORMATTER,
  paymentResourceOf,
  resolveAddressFormatter,
  resolveErrorMessageMode,
  resolvePaymentResourceMode,
  serializeFunctionArguments,
} from './privacy.js';
import { joinConfirm } from './tracker/confirm-claim.js';
import {
  errorType,
  type HandleOptions,
  handleOptions,
  identifier,
  OBSERVER_TIMEOUT,
  reportedErrorType,
  safely,
} from './tracker/handles.js';
import { createSpanRecording, metricAttributes, secondsSince } from './tracker/spans.js';
import {
  ADDRESS,
  amount,
  ownValue,
  quantity,
  smallQuantity,
  TX_HASH,
  toInt,
} from './tracker/values.js';
import type {
  CallBatchConfirmHandle,
  CallBatchConfirmInput,
  CallBatchInput,
  CallBatchSendHandle,
  CallBatchStatusLike,
  ConfirmHandle,
  ConfirmInput,
  EndOptions,
  FailOptions,
  PaymentHandle,
  PaymentInput,
  PaymentSettlement,
  ReceiptLike,
  ReplacementReason,
  SendHandle,
  SendInput,
  SendResult,
  TxTrackerOptions,
  UserOperationConfirmHandle,
  UserOperationConfirmInput,
  UserOperationInput,
  UserOperationReceiptLike,
  UserOperationSendHandle,
} from './types.js';
import { VERSION } from './version.js';

const INSTRUMENTATION_NAME = '@hashspan/core';
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 10_000;

const ZERO_ADDRESS = /^0x0{40}$/;

/** `error.type` of a call batch that failed without being included (EIP-5792 status 400). */
const CALL_BATCH_FAILED = 'failed';
/** A call batch id: `0x`-prefixed hex of at most 8194 characters, the bound EIP-5792 sets. */
const CALL_BATCH_ID = /^0x[0-9a-fA-F]{1,8192}$/;
/** Longest call batch id recorded as an attribute. */
const MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH = 256;
/** Most transaction hashes recorded for one call batch. */
const MAX_CALL_BATCH_TRANSACTION_HASHES = 64;

/** Most EIP-7702 authorizations listed on a send span; the count covers all of them. */
const MAX_AUTHORIZATIONS = 64;

/** EIP-5792 status code of a batch that is still pending. */
const CALL_BATCH_PENDING = 100;

const PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED,
]);

const REPLACEMENT_REASONS: ReadonlySet<string> = new Set([
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPRICED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_CANCELLED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPLACED,
]);

/** Records nothing; its context is the parent, so a call run in it still nests under the caller. */
const noopSend = (parent: Context): SendHandle => ({
  context: parent,
  end: () => {},
  fail: () => {},
});

const noopUserOperationSend = (parent: Context): UserOperationSendHandle => ({
  context: parent,
  end: () => {},
  fail: () => {},
});

const NOOP_PAYMENT: PaymentHandle = {
  end: () => {},
  fail: () => {},
  timeout: () => {},
  link: () => {},
};

const NOOP_CONFIRM: ConfirmHandle = { end: () => {}, timeout: () => {}, fail: () => {} };

const NOOP_USER_OPERATION_CONFIRM: UserOperationConfirmHandle = {
  end: () => {},
  timeout: () => {},
  fail: () => {},
};

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

/** The confirm span of one transaction and how to end it; shared by all its handles. */
interface ConfirmSpan extends SharedConfirm {
  /**
   * What a confirm span of a replacing transaction inherits from this one
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0008-replaced-transactions.md).
   */
  origin: ConfirmOrigin;
  receipt(receipt: ReceiptLike, endTime?: TimeInput): void;
  timeout(endTime?: TimeInput): void;
  fail(error: unknown, endTime?: TimeInput): void;
  /** Ends as replaced by the transaction `hash`. */
  replaced(hash: string, reason: ReplacementReason | undefined, endTime?: TimeInput): void;
  /** Ends as a failure without any receipt data, for a receipt that cannot be attributed. */
  unattributable(endTime?: TimeInput): void;
}

interface ConfirmOrigin {
  parent: Context;
  startTime: TimeInput;
  links: Link[];
}

/** The confirm span of one user operation and how to end it; shared by all its handles. */
interface UserOperationConfirmSpan extends SharedConfirm {
  receipt(receipt: UserOperationReceiptLike, endTime?: TimeInput): void;
  timeout(endTime?: TimeInput): void;
  fail(error: unknown, options: HandleOptions): void;
}

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
  /** Metric attributes of a user operation sample: as for transactions, plus what the sample is about. */
  const userOperationMetricAttributes = (chainId: number, extra: Attributes = {}): Attributes =>
    metricAttributes(chainId, {
      [ATTR_BLOCKCHAIN_OPERATION_SUBJECT]: BLOCKCHAIN_OPERATION_SUBJECT_VALUE_USER_OPERATION,
      ...extra,
    });
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
  const { redact, markError, finisher, setAddress, setRemoteAddress, baseAttributes } = recording;

  /**
   * Records an EIP-7702 authorization list: its length, and for each well-formed entry (an address and a non-negative
   * integer chain id, read from own data properties only) its address per the address mode and its chain id, at most
   * {@link MAX_AUTHORIZATIONS}. The two lists stay aligned: an entry is listed in both or in neither.
   */
  const setAuthorizations = (attributes: Attributes, list: unknown): void => {
    if (!Array.isArray(list) || list.length === 0) return;
    attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT] = list.length;
    const addresses: string[] = [];
    const chainIds: number[] = [];
    for (const entry of list.slice(0, MAX_AUTHORIZATIONS)) {
      const address = ownValue(entry, 'address');
      const chainId = ownValue(entry, 'chainId');
      if (typeof address !== 'string' || !ADDRESS.test(address)) continue;
      if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 0) continue;
      const formatted = formatAddress(address);
      if (formatted !== undefined) addresses.push(formatted);
      chainIds.push(chainId);
    }
    if (addresses.length > 0) attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES] = addresses;
    if (chainIds.length > 0) attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS] = chainIds;
  };

  const startSend = (input: SendInput, parentCtx?: Context): SendHandle => {
    const parent = parentCtx ?? context.active();
    const attributes = baseAttributes(input.chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setAddress(attributes, ATTR_BLOCKCHAIN_TX_FROM, input.from);
    setAddress(attributes, ATTR_BLOCKCHAIN_TX_TO, input.to);
    if (input.value !== undefined) attributes[ATTR_BLOCKCHAIN_TX_VALUE] = input.value.toString();
    if (input.nonce !== undefined) attributes[ATTR_BLOCKCHAIN_TX_NONCE] = input.nonce;
    try {
      setAuthorizations(attributes, input.authorizations);
    } catch (error) {
      diag.debug(`hashspan: could not record authorizations (${errorType(error)})`);
    }
    if (input.functionName !== undefined) {
      attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME] = input.functionName;
    }
    if (input.functionSelector !== undefined) {
      attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR] = input.functionSelector;
    }
    if (options.recordFunctionArguments === true && input.functionArguments !== undefined) {
      try {
        attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS] = serializeFunctionArguments(
          input.functionArguments,
          formatAddress,
        );
      } catch (error) {
        diag.debug(`hashspan: could not serialize function arguments (${errorType(error)})`);
      }
    }

    const span = getTracer().startSpan(
      `send ${input.chainId}`,
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
        metricAttributes(
          input.chainId,
          errorType === undefined ? {} : { [ATTR_ERROR_TYPE]: errorType },
        ),
      );

    return {
      context: trace.setSpan(parent, span),
      end: (result: SendResult | string, second?: EndOptions | TimeInput): void =>
        finish(
          'record transaction hash',
          () => {
            const hash: unknown = typeof result === 'string' ? result : result?.hash;
            if (typeof hash !== 'string') {
              diag.debug('hashspan: ending a send span without a transaction hash');
              return;
            }
            links.set(input.chainId, hash, { spanContext: span.spanContext(), parent });
            span.setAttributes(redact({ [ATTR_BLOCKCHAIN_TX_HASH]: hash }));
            recordSend(handleOptions(second).endTime);
          },
          handleOptions(second).endTime,
        ),
      fail: (error: unknown, second?: FailOptions | TimeInput, third?: FailOptions): void => {
        const options = handleOptions(second, third);
        finish(
          'record send failure',
          () =>
            recordSend(
              options.endTime,
              markError(span, reportedErrorType(error, options), error, errorType(error)),
            ),
          options.endTime,
        );
      },
    };
  };

  const receiptAttributes = (receipt: ReceiptLike): Attributes => {
    const attributes: Attributes = {
      [ATTR_BLOCKCHAIN_TX_STATUS]:
        receipt.status === 'reverted'
          ? BLOCKCHAIN_TX_STATUS_VALUE_REVERTED
          : BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
      [ATTR_BLOCKCHAIN_BLOCK_NUMBER]: toInt(receipt.blockNumber),
      [ATTR_BLOCKCHAIN_TX_GAS_USED]: toInt(receipt.gasUsed),
    };
    const l1Fee = receipt.l1Fee ?? undefined;
    if (l1Fee !== undefined) attributes[ATTR_BLOCKCHAIN_TX_L1_FEE] = l1Fee.toString();
    if (receipt.effectiveGasPrice !== undefined) {
      attributes[ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE] = receipt.effectiveGasPrice.toString();
      const executionFee = BigInt(receipt.gasUsed) * receipt.effectiveGasPrice;
      attributes[ATTR_BLOCKCHAIN_TX_FEE] = (executionFee + (l1Fee ?? 0n)).toString();
    }
    if (receipt.revertReason !== undefined) {
      attributes[ATTR_BLOCKCHAIN_TX_REVERT_REASON] = formatAddressesIn(
        receipt.revertReason,
        formatAddress,
      );
    }
    return attributes;
  };

  /** Opens the confirm span of a transaction; `replacing` is the confirm span of the transaction it replaced. */
  const openConfirm = (
    input: ConfirmInput,
    parentCtx?: Context,
    replacing?: ConfirmOrigin,
  ): ConfirmSpan => {
    const sent = links.get(input.chainId, input.hash);
    const active = context.active();
    const parent =
      replacing?.parent ?? parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(
      input.chainId,
      BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
      parent,
    );
    attributes[ATTR_BLOCKCHAIN_TX_HASH] = input.hash;
    const spanLinks: Link[] = [
      ...(replacing?.links ?? []),
      ...(sent ? [{ context: sent.spanContext }] : []),
    ];
    // Only spans recorded after the fact get an explicit start time (a replacing transaction's, or one an adapter
    // records late): with one, the SDK measures the end time with the wall clock instead of the monotonic clock.
    const explicitStart = input.startTime ?? replacing?.startTime;

    const span = getTracer().startSpan(
      `confirm ${input.chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        links: spanLinks,
        ...(explicitStart !== undefined ? { startTime: explicitStart } : {}),
      },
      parent,
    );
    const finish = finisher(span);
    const startMs = toEpochMs(explicitStart);
    const recordConfirmation = (endTime: TimeInput | undefined, outcome: Attributes): void =>
      txMetrics.confirmationDuration(
        secondsSince(startMs, endTime),
        metricAttributes(input.chainId, outcome),
      );
    const origin: ConfirmOrigin = {
      parent,
      startTime: explicitStart ?? new Date(),
      links: [{ context: span.spanContext() }, ...(sent ? [{ context: sent.spanContext }] : [])],
    };

    return {
      active: 0,
      ended: false,
      origin,
      receipt: (receipt, endTime) =>
        finish(
          'record receipt',
          () => {
            const attributes = receiptAttributes(receipt);
            span.setAttributes(redact(attributes));
            if (receipt.status === 'reverted') markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
            const status = { [ATTR_BLOCKCHAIN_TX_STATUS]: attributes[ATTR_BLOCKCHAIN_TX_STATUS] };
            recordConfirmation(endTime, status);
            const fee = attributes[ATTR_BLOCKCHAIN_TX_FEE];
            if (typeof fee === 'string')
              txMetrics.fee(BigInt(fee), metricAttributes(input.chainId, status));
          },
          endTime,
        ),
      // Giving up describes the observer, not the transaction: no blockchain.tx.status (docs/adr/0016).
      timeout: (endTime) =>
        finish(
          'record confirmation timeout',
          () =>
            recordConfirmation(endTime, { [ATTR_ERROR_TYPE]: markError(span, OBSERVER_TIMEOUT) }),
          endTime,
        ),
      fail: (error, endTime) =>
        finish(
          'record confirmation failure',
          () =>
            recordConfirmation(endTime, {
              [ATTR_ERROR_TYPE]: markError(span, errorType(error), error),
            }),
          endTime,
        ),
      replaced: (hash, reason, endTime) =>
        finish(
          'record replacement',
          () => {
            const attributes: Attributes = {
              [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
              [ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH]: hash,
            };
            if (reason !== undefined && REPLACEMENT_REASONS.has(reason)) {
              attributes[ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON] = reason;
            }
            span.setAttributes(redact(attributes));
            recordConfirmation(endTime, {
              [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
            });
          },
          endTime,
        ),
      unattributable: (endTime) =>
        finish(
          'record unattributable receipt',
          () =>
            recordConfirmation(endTime, {
              [ATTR_ERROR_TYPE]: markError(span, ERROR_TYPE_VALUE_OTHER),
            }),
          endTime,
        ),
    };
  };

  /**
   * Records `receipt` for the replacing transaction `hash`: ends its in-flight confirm span, does nothing if it
   * already settled, and otherwise opens one that inherits parent, start time and links from `original`.
   */
  const recordReplacing = (
    chainId: number,
    hash: string,
    receipt: ReceiptLike,
    original: ConfirmOrigin,
    endTime: TimeInput | undefined,
  ): void => {
    const current = confirmations.get(chainId, hash);
    if (current === 'settled' || current?.ended) return;
    const confirm = current ?? openConfirm({ chainId, hash }, undefined, original);
    if (!current) confirmations.start(chainId, hash, confirm);
    confirm.ended = true;
    confirmations.settle(chainId, hash, confirm);
    const { replacementReason: _reason, ...mined } = receipt;
    confirm.receipt(mined, endTime);
  };

  /**
   * Ends `shared` with `receipt`, attributing it to the transaction that was mined
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0008-replaced-transactions.md).
   */
  const endWithReceipt = (
    chainId: number,
    hash: string,
    shared: ConfirmSpan,
    receipt: ReceiptLike,
    endTime: TimeInput | undefined,
  ): void => {
    const mined: unknown = receipt.transactionHash;
    if (mined === undefined) {
      confirmations.settle(chainId, hash, shared);
      shared.receipt(receipt, endTime);
      return;
    }
    // Validated before it is compared or used as a registry key.
    if (typeof mined !== 'string' || !TX_HASH.test(mined)) {
      diag.warn('hashspan: receipt has an invalid transaction hash; not recording it');
      confirmations.release(chainId, hash, shared);
      shared.unattributable(endTime);
      return;
    }
    if (mined.toLowerCase() === hash.toLowerCase()) {
      confirmations.settle(chainId, hash, shared);
      shared.receipt(receipt, endTime);
      return;
    }
    confirmations.settle(chainId, hash, shared);
    shared.replaced(mined, receipt.replacementReason, endTime);
    safely(
      'record replacing transaction',
      () => recordReplacing(chainId, mined, receipt, shared.origin, endTime),
      undefined,
    );
  };

  /**
   * Joins the confirm span of the transaction, opening it for the first handle. A receipt from any handle ends the
   * span; a timeout or failure only ends it when it is the last handle still waiting.
   */
  const startConfirm = (input: ConfirmInput, parentCtx?: Context): ConfirmHandle => {
    const { chainId, hash } = input;
    const claim = joinConfirm(confirmations, chainId, hash, () => openConfirm(input, parentCtx));
    if (!claim) return NOOP_CONFIRM;
    const { shared } = claim;
    return {
      end: (receipt: ReceiptLike, second?: EndOptions | TimeInput): void => {
        const { endTime } = handleOptions(second);
        if (!claim.receive()) return;
        safely(
          'record receipt',
          () => endWithReceipt(chainId, hash, shared, receipt, endTime),
          undefined,
        );
      },
      timeout: (second?: EndOptions | TimeInput): void => {
        const { endTime } = handleOptions(second);
        claim.withdraw(() => shared.timeout(endTime));
      },
      fail: (error: unknown, second?: EndOptions | TimeInput): void => {
        const { endTime } = handleOptions(second);
        claim.withdraw(() => shared.fail(error, endTime));
      },
    };
  };

  const startPayment = (input: PaymentInput, parentCtx?: Context): PaymentHandle => {
    const parent = parentCtx ?? context.active();
    const attributes = baseAttributes(
      input.chainId,
      BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT,
      parent,
    );
    const protocol = identifier(input.protocol);
    if (protocol !== undefined) attributes[ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL] = protocol;
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_PAYER, input.payer);
    const knownPayer = typeof input.payer === 'string' && ADDRESS.test(input.payer);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT, input.recipient);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_ASSET, input.asset);
    const paid = amount(input.amount);
    if (paid !== undefined) attributes[ATTR_BLOCKCHAIN_PAYMENT_AMOUNT] = paid;
    const scheme = identifier(input.x402?.scheme);
    if (scheme !== undefined) attributes[ATTR_X402_SCHEME] = scheme;
    const resource = input.x402?.resource;
    const recorded =
      typeof resource === 'string' ? paymentResourceOf(resource, paymentResource) : undefined;
    if (recorded) attributes[ATTR_X402_RESOURCE] = formatAddressesIn(recorded, formatAddress);

    const span = getTracer().startSpan(
      `payment ${input.chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      },
      parent,
    );
    const finish = finisher(span);

    /** Links the confirm span of `hash` to this payment span, unless the tracker already links that hash. */
    const linkHash = (hash: unknown): hash is string => {
      if (typeof hash !== 'string' || !TX_HASH.test(hash)) return false;
      // A hash this tracker already links, such as one of its own sends, keeps that link.
      if (!links.get(input.chainId, hash)) {
        links.set(input.chainId, hash, { spanContext: span.spanContext(), parent });
      }
      return true;
    };

    const recordSettlement = (settlement: PaymentSettlement): void => {
      const status = settlement.status;
      if (!PAYMENT_STATUSES.has(status)) {
        diag.debug('hashspan: ignoring a payment settlement with an unknown status');
        return;
      }
      // The settlement comes from the settling party, which the payer does not control: it never replaces what the
      // payer knew itself (docs/adr/0013-x402-payments.md).
      const settled: Attributes = { [ATTR_BLOCKCHAIN_PAYMENT_STATUS]: status };
      const hash: unknown = settlement.hash;
      if (linkHash(hash)) {
        settled[ATTR_BLOCKCHAIN_TX_HASH] = hash;
      }
      if (!knownPayer) setRemoteAddress(settled, ATTR_BLOCKCHAIN_PAYMENT_PAYER, settlement.payer);
      // Recorded as reported, next to the amount the payer knew, which it never replaces.
      const settledAmount = amount(settlement.amount);
      if (settledAmount !== undefined) {
        settled[ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT] = settledAmount;
        if (paid === undefined) settled[ATTR_BLOCKCHAIN_PAYMENT_AMOUNT] = settledAmount;
      }
      const verified: unknown = settlement.verified;
      if (typeof verified === 'boolean') settled[ATTR_BLOCKCHAIN_PAYMENT_VERIFIED] = verified;
      span.setAttributes(redact(settled));
      if (status === BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED) {
        markError(span, identifier(settlement.errorReason) ?? ERROR_TYPE_VALUE_OTHER);
      }
    };

    return {
      end: (settlement, options) =>
        finish(
          'record payment settlement',
          () => recordSettlement(settlement),
          handleOptions(options).endTime,
        ),
      fail: (error, options) => {
        const read = handleOptions(options);
        finish(
          'record payment failure',
          () => markError(span, reportedErrorType(error, read), error, errorType(error)),
          read.endTime,
        );
      },
      timeout: (options) =>
        finish(
          'record payment timeout',
          () => markError(span, OBSERVER_TIMEOUT),
          handleOptions(options).endTime,
        ),
      link: (hash) => safely('link the payment span', () => void linkHash(hash), undefined),
    };
  };

  const startUserOperationSend = (
    input: UserOperationInput,
    parentCtx?: Context,
  ): UserOperationSendHandle => {
    const parent = parentCtx ?? context.active();
    const { chainId } = input;
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_SENDER, input.sender);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT, input.entryPoint);
    const callCount = smallQuantity(input.callCount);
    if (callCount !== undefined) attributes[ATTR_BLOCKCHAIN_USER_OPERATION_CALL_COUNT] = callCount;

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
        userOperationMetricAttributes(
          chainId,
          errorType === undefined ? {} : { [ATTR_ERROR_TYPE]: errorType },
        ),
      );

    return {
      context: trace.setSpan(parent, span),
      end: (result, second) => {
        const { endTime } = handleOptions(second);
        finish(
          'record user operation hash',
          () => {
            const hash: unknown = result?.userOpHash;
            // The hash comes from the bundler: validated before it is recorded or used as a key.
            if (typeof hash !== 'string' || !TX_HASH.test(hash)) {
              diag.debug('hashspan: ending a send span without a valid user operation hash');
              return;
            }
            userOperationLinks.set(chainId, hash, { spanContext: span.spanContext(), parent });
            span.setAttributes(redact({ [ATTR_BLOCKCHAIN_USER_OPERATION_HASH]: hash }));
            recordSend(endTime);
          },
          endTime,
        );
      },
      fail: (error, second) => {
        const read = handleOptions(second);
        finish(
          'record user operation send failure',
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

  /**
   * Attributes of a user operation receipt. Its values come from a bundler: what is malformed is left out. The bundle
   * transaction's status, gas and fee are not recorded: they cover every operation in the bundle (ADR 0021).
   */
  const userOperationReceiptAttributes = (receipt: UserOperationReceiptLike): Attributes => {
    const attributes: Attributes = {};
    const success: unknown = receipt.success;
    if (typeof success === 'boolean') attributes[ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS] = success;
    const gasUsed = smallQuantity(receipt.actualGasUsed);
    if (gasUsed !== undefined) attributes[ATTR_BLOCKCHAIN_USER_OPERATION_GAS_USED] = gasUsed;
    const gasCost = quantity(receipt.actualGasCost);
    if (gasCost !== undefined) {
      attributes[ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST] = gasCost.toString();
    }
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_SENDER, receipt.sender);
    // 192-bit key and 64-bit sequence number: too large for an int attribute.
    const nonce = quantity(receipt.nonce);
    if (nonce !== undefined) attributes[ATTR_BLOCKCHAIN_USER_OPERATION_NONCE] = nonce.toString();
    const paymaster: unknown = receipt.paymaster;
    if (typeof paymaster === 'string' && !ZERO_ADDRESS.test(paymaster)) {
      setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_PAYMASTER, paymaster);
    }
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT, receipt.entryPoint);
    const reason: unknown = receipt.revertReason;
    if (typeof reason === 'string') {
      attributes[ATTR_BLOCKCHAIN_TX_REVERT_REASON] = formatAddressesIn(reason, formatAddress);
    }
    const bundle: unknown = receipt.transactionHash;
    if (typeof bundle === 'string' && TX_HASH.test(bundle))
      attributes[ATTR_BLOCKCHAIN_TX_HASH] = bundle;
    const block = smallQuantity(receipt.blockNumber);
    if (block !== undefined) attributes[ATTR_BLOCKCHAIN_BLOCK_NUMBER] = block;
    return attributes;
  };

  /** Opens the confirm span of a user operation. */
  const openUserOperationConfirm = (
    input: UserOperationConfirmInput,
    parentCtx?: Context,
  ): UserOperationConfirmSpan => {
    const { chainId, userOpHash } = input;
    const sent = userOperationLinks.get(chainId, userOpHash);
    const active = context.active();
    const parent = parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM, parent);
    attributes[ATTR_BLOCKCHAIN_USER_OPERATION_HASH] = userOpHash;
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
        userOperationMetricAttributes(chainId, outcome),
      );

    return {
      active: 0,
      ended: false,
      receipt: (receipt, endTime) =>
        finish(
          'record user operation receipt',
          () => {
            const attributes = userOperationReceiptAttributes(receipt ?? {});
            span.setAttributes(redact(attributes));
            const success = attributes[ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS];
            if (success === false) markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
            // The outcome from chain data is the operation's success flag, not the bundle's status (ADR 0020).
            const outcome: Attributes =
              typeof success === 'boolean'
                ? { [ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS]: success }
                : {};
            recordConfirmation(endTime, outcome);
            const cost = attributes[ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST];
            if (typeof cost === 'string') {
              txMetrics.fee(BigInt(cost), userOperationMetricAttributes(chainId, outcome));
            }
          },
          endTime,
        ),
      timeout: (endTime) =>
        finish(
          'record user operation confirmation timeout',
          () =>
            recordConfirmation(endTime, { [ATTR_ERROR_TYPE]: markError(span, OBSERVER_TIMEOUT) }),
          endTime,
        ),
      fail: (error, read) =>
        finish(
          'record user operation confirmation failure',
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

  const startUserOperationConfirm = (
    input: UserOperationConfirmInput,
    parentCtx?: Context,
  ): UserOperationConfirmHandle => {
    const { chainId, userOpHash } = input;
    if (typeof userOpHash !== 'string' || !TX_HASH.test(userOpHash)) {
      diag.debug('hashspan: not confirming a user operation without a valid hash');
      return NOOP_USER_OPERATION_CONFIRM;
    }
    const claim = joinConfirm(userOperationConfirmations, chainId, userOpHash, () =>
      openUserOperationConfirm(input, parentCtx),
    );
    if (!claim) return NOOP_USER_OPERATION_CONFIRM;
    const { shared } = claim;
    return {
      end: (receipt, second) => {
        const { endTime } = handleOptions(second);
        if (!claim.receive()) return;
        userOperationConfirmations.settle(chainId, userOpHash, shared);
        shared.receipt(receipt, endTime);
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
