import {
  type Attributes,
  type Context,
  context,
  diag,
  type Link,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TimeInput,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { agentAttributes } from './agent.js';
import {
  ATTR_BLOCKCHAIN_BLOCK_NUMBER,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_PAYMENT_AMOUNT,
  ATTR_BLOCKCHAIN_PAYMENT_ASSET,
  ATTR_BLOCKCHAIN_PAYMENT_PAYER,
  ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL,
  ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT,
  ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT,
  ATTR_BLOCKCHAIN_PAYMENT_STATUS,
  ATTR_BLOCKCHAIN_PAYMENT_VERIFIED,
  ATTR_BLOCKCHAIN_SYSTEM,
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
  ATTR_ERROR_TYPE,
  ATTR_X402_RESOURCE,
  ATTR_X402_SCHEME,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED,
  BLOCKCHAIN_SYSTEM_VALUE_EVM,
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
import {
  type AddressFormatter,
  formatAddressesIn,
  OFF_ADDRESS_FORMATTER,
  paymentResourceOf,
  resolveAddressFormatter,
  resolveErrorMessageMode,
  resolvePaymentResourceMode,
  sanitizeErrorMessage,
  serializeFunctionArguments,
} from './privacy.js';
import type {
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
} from './types.js';
import { VERSION } from './version.js';

const INSTRUMENTATION_NAME = '@hashspan/core';
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 10_000;

/** OpenTelemetry exception event and attributes. */
const EXCEPTION_EVENT = 'exception';
const ATTR_EXCEPTION_TYPE = 'exception.type';
const ATTR_EXCEPTION_MESSAGE = 'exception.message';
const ATTR_EXCEPTION_STACKTRACE = 'exception.stacktrace';

/** Attributes kept when the redaction hook fails (fail closed). */
const NON_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  ATTR_BLOCKCHAIN_SYSTEM,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON,
  ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL,
  ATTR_BLOCKCHAIN_PAYMENT_STATUS,
  ATTR_BLOCKCHAIN_PAYMENT_VERIFIED,
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_TYPE,
]);

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A non-negative integer that fits in 256 bits. */
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
/** `error.type` of a wait that gave up: a confirmation or a payment whose outcome was never learned. */
const OBSERVER_TIMEOUT = 'timeout';
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

/**
 * Records transactions and payments as spans. Obtain one from {@link createTxTracker}: it is not meant to be
 * implemented, and members may be added to it and to its handles in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.6.0/docs/adr/0014-core-api-boundary.md).
 */
export interface TxTracker {
  /**
   * Starts a `send` span as a child of `parent` (default: the active context).
   * Call `end(hash)` once the transaction hash is known, or `fail(error)`.
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.6.0/docs/adr/0013-x402-payments.md). Call
   * `end(settlement)` with the settlement, or `fail(error)`. A settlement with a hash links the transaction's confirm
   * span to this span, as a send span would.
   */
  startPayment(input: PaymentInput, parent?: Context): PaymentHandle;
}

/** Records nothing; its context is the parent, so a call run in it still nests under the caller. */
const noopSend = (parent: Context): SendHandle => ({
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

/** Runs `fn`, logging instead of throwing: instrumentation must never break the caller. */
function safely<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    diag.error(`hashspan: failed to ${what}`, error);
    return fallback;
  }
}

function toInt(value: bigint | number): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`expected bigint or number, got ${typeof value}`);
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : ERROR_TYPE_VALUE_OTHER;
}

const ERROR_TYPE_OVERRIDE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `value` if it is a short identifier, the only kind of free text recorded from a remote party. */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && ERROR_TYPE_OVERRIDE.test(value) ? value : undefined;
}

/** A decimal amount, or undefined when `value` is not a non-negative integer. */
function amount(value: unknown): string | undefined {
  const text = typeof value === 'bigint' ? value.toString() : value;
  return typeof text === 'string' && AMOUNT.test(text) ? text : undefined;
}

/** The `error.type` for a failure: an adapter's override when it is a short identifier, else the class name. */
/** A finite number, an `HrTime` pair or a `Date`: what the deprecated positional `endTime` argument takes. */
function isTimeInput(value: unknown): value is TimeInput {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number';
  }
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** The options a handle method was called with, read once. */
interface HandleOptions {
  endTime?: TimeInput | undefined;
  errorType?: unknown;
}

/**
 * Reads the options of a handle method called as `(what, options?)` or, deprecated, as `(what, endTime?, options?)`
 * (ADR 0014). A positional end time wins over `options.endTime`. Never throws: an argument of neither form, or an
 * end time that is not one, is ignored.
 */
function handleOptions(second: unknown, third?: unknown): HandleOptions {
  try {
    const positional = isTimeInput(second) ? second : undefined;
    const given = positional !== undefined || second === undefined ? third : (second as unknown);
    if (
      given !== undefined &&
      (typeof given !== 'object' || given === null || isTimeInput(given))
    ) {
      diag.debug('hashspan: ignoring a handle argument that is neither options nor an end time');
      return positional !== undefined ? { endTime: positional } : {};
    }
    const options = given as FailOptions | undefined;
    const endTime: unknown = positional ?? options?.endTime;
    if (endTime !== undefined && !isTimeInput(endTime)) {
      diag.debug('hashspan: ignoring an end time that is not a TimeInput');
    }
    return {
      endTime: isTimeInput(endTime) ? endTime : undefined,
      errorType: options?.errorType,
    };
  } catch (error) {
    diag.debug(`hashspan: could not read handle options (${errorType(error)})`);
    return {};
  }
}

function reportedErrorType(error: unknown, options: HandleOptions | undefined): string {
  const override = options?.errorType;
  if (override === undefined) return errorType(error);
  if (typeof override === 'string' && ERROR_TYPE_OVERRIDE.test(override)) return override;
  diag.debug('hashspan: ignoring an error type that is not a short identifier');
  return errorType(error);
}

/** The confirm span of one transaction and how to end it; shared by all its handles. */
interface ConfirmSpan extends SharedConfirm {
  /**
   * What a confirm span of a replacing transaction inherits from this one
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.6.0/docs/adr/0008-replaced-transactions.md).
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

/**
 * Creates a tracker that records transactions as `send` and `confirm` spans, and payments as `payment` spans, with
 * `@opentelemetry/api` (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.6.0/docs/semconv.md). It makes
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
  let tracer: Tracer | undefined;
  const getTracer = (): Tracer => {
    tracer ??= (options.tracerProvider ?? trace.getTracerProvider()).getTracer(
      INSTRUMENTATION_NAME,
      VERSION,
    );
    return tracer;
  };

  const nonSensitive = (attributes: Attributes): Attributes =>
    Object.fromEntries(Object.entries(attributes).filter(([key]) => NON_SENSITIVE_KEYS.has(key)));

  const redact = (attributes: Attributes): Attributes => {
    if (!options.redact) return attributes;
    let redacted: unknown;
    try {
      redacted = options.redact({ ...attributes });
    } catch (error) {
      diag.error('hashspan: redaction hook failed; recording non-sensitive attributes only', error);
      return nonSensitive(attributes);
    }
    if (typeof redacted !== 'object' || redacted === null || Array.isArray(redacted)) {
      diag.error(
        'hashspan: redaction hook must return an attributes object; recording non-sensitive attributes only',
      );
      return nonSensitive(attributes);
    }
    return redacted as Attributes;
  };

  /**
   * Exception event attributes for `error`, per the error message mode. The error object itself is never handed to
   * the SDK: its message and stack can carry addresses and calldata
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.6.0/docs/adr/0006-error-privacy.md).
   */
  const exceptionAttributes = (type: string, error: unknown): Attributes => {
    const attributes: Attributes = { [ATTR_EXCEPTION_TYPE]: type };
    if (errorMessages === 'off') return attributes;
    const message = error instanceof Error ? error.message : String(error);
    if (errorMessages === 'sanitized') {
      const sanitized = sanitizeErrorMessage(message, formatAddress);
      if (sanitized) attributes[ATTR_EXCEPTION_MESSAGE] = sanitized;
      return attributes;
    }
    attributes[ATTR_EXCEPTION_MESSAGE] = message;
    if (error instanceof Error && error.stack) attributes[ATTR_EXCEPTION_STACKTRACE] = error.stack;
    return attributes;
  };

  /**
   * Error names are free text too: they follow the address mode and pass through the redaction hook.
   * `exceptionName` is the class name for `exception.type` when `errorName` is an adapter's error type.
   */
  const markError = (
    span: Span,
    errorName: string,
    error?: unknown,
    exceptionName: string = errorName,
  ): void => {
    const type = formatAddressesIn(errorName, formatAddress);
    let message: string | undefined;
    if (error !== undefined) {
      const exception = redact(
        exceptionAttributes(formatAddressesIn(exceptionName, formatAddress), error),
      );
      span.addEvent(EXCEPTION_EVENT, exception);
      const recorded = exception[ATTR_EXCEPTION_MESSAGE];
      if (typeof recorded === 'string') message = recorded;
    }
    span.setAttributes(redact({ [ATTR_ERROR_TYPE]: type }));
    span.setStatus({ code: SpanStatusCode.ERROR, ...(message !== undefined ? { message } : {}) });
  };

  /** Ends a span exactly once; the span is always ended even if recording attributes fails. */
  const finisher = (span: Span) => {
    let ended = false;
    return (what: string, record: () => void, endTime?: TimeInput): void => {
      if (ended) return;
      ended = true;
      try {
        record();
      } catch (error) {
        diag.error(`hashspan: failed to ${what}`, error);
      } finally {
        safely('end span', () => span.end(endTime), undefined);
      }
    };
  };

  const setAddress = (attributes: Attributes, key: string, address: string | undefined): void => {
    if (address === undefined) return;
    const formatted = formatAddress(address);
    if (formatted !== undefined) attributes[key] = formatted;
  };

  /** Records `address` only if it is one: payment addresses come from remote parties. */
  const setPaymentAddress = (attributes: Attributes, key: string, address: unknown): void => {
    if (typeof address === 'string' && ADDRESS.test(address)) setAddress(attributes, key, address);
  };

  const baseAttributes = (chainId: number, operation: string, ctx: Context): Attributes => ({
    [ATTR_BLOCKCHAIN_SYSTEM]: BLOCKCHAIN_SYSTEM_VALUE_EVM,
    [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId,
    [ATTR_BLOCKCHAIN_OPERATION_NAME]: operation,
    ...agentAttributes(ctx, options.agent, options.agentFromBaggage !== false),
  });

  const startSend = (input: SendInput, parentCtx?: Context): SendHandle => {
    const parent = parentCtx ?? context.active();
    const attributes = baseAttributes(input.chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setAddress(attributes, ATTR_BLOCKCHAIN_TX_FROM, input.from);
    setAddress(attributes, ATTR_BLOCKCHAIN_TX_TO, input.to);
    if (input.value !== undefined) attributes[ATTR_BLOCKCHAIN_TX_VALUE] = input.value.toString();
    if (input.nonce !== undefined) attributes[ATTR_BLOCKCHAIN_TX_NONCE] = input.nonce;
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
          },
          handleOptions(second).endTime,
        ),
      fail: (error: unknown, second?: FailOptions | TimeInput, third?: FailOptions): void => {
        const options = handleOptions(second, third);
        finish(
          'record send failure',
          () => markError(span, reportedErrorType(error, options), error, errorType(error)),
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
            span.setAttributes(redact(receiptAttributes(receipt)));
            if (receipt.status === 'reverted') markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
          },
          endTime,
        ),
      // Giving up describes the observer, not the transaction: no blockchain.tx.status (docs/adr/0016).
      timeout: (endTime) =>
        finish('record confirmation timeout', () => markError(span, OBSERVER_TIMEOUT), endTime),
      fail: (error, endTime) =>
        finish(
          'record confirmation failure',
          () => markError(span, errorType(error), error),
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
          },
          endTime,
        ),
      unattributable: (endTime) =>
        finish(
          'record unattributable receipt',
          () => markError(span, ERROR_TYPE_VALUE_OTHER),
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.6.0/docs/adr/0008-replaced-transactions.md).
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
    const current = confirmations.get(chainId, hash);
    if (current === 'settled') return NOOP_CONFIRM;
    let confirm = current;
    if (!confirm) {
      confirm = openConfirm(input, parentCtx);
      confirmations.start(chainId, hash, confirm);
    }
    const shared = confirm;
    shared.active += 1;
    let done = false;

    const withdraw = (end: () => void): void => {
      if (done || shared.ended) return;
      done = true;
      shared.active -= 1;
      if (shared.active > 0) return;
      shared.ended = true;
      confirmations.release(chainId, hash, shared);
      end();
    };

    return {
      end: (receipt: ReceiptLike, second?: EndOptions | TimeInput): void => {
        const { endTime } = handleOptions(second);
        if (done || shared.ended) return;
        done = true;
        shared.active -= 1;
        shared.ended = true;
        safely(
          'record receipt',
          () => endWithReceipt(chainId, hash, shared, receipt, endTime),
          undefined,
        );
      },
      timeout: (second?: EndOptions | TimeInput): void => {
        const { endTime } = handleOptions(second);
        withdraw(() => shared.timeout(endTime));
      },
      fail: (error: unknown, second?: EndOptions | TimeInput): void => {
        const { endTime } = handleOptions(second);
        withdraw(() => shared.fail(error, endTime));
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
    setPaymentAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_PAYER, input.payer);
    const knownPayer = typeof input.payer === 'string' && ADDRESS.test(input.payer);
    setPaymentAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT, input.recipient);
    setPaymentAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_ASSET, input.asset);
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
      if (!knownPayer) setPaymentAddress(settled, ATTR_BLOCKCHAIN_PAYMENT_PAYER, settlement.payer);
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
  };
}
