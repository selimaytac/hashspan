import {
  type Attributes,
  type Context,
  context,
  diag,
  type Link,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { agentAttributes } from './agent.js';
import {
  ATTR_BLOCKCHAIN_BLOCK_NUMBER,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_SYSTEM,
  ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE,
  ATTR_BLOCKCHAIN_TX_FEE,
  ATTR_BLOCKCHAIN_TX_FROM,
  ATTR_BLOCKCHAIN_TX_GAS_USED,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_L1_FEE,
  ATTR_BLOCKCHAIN_TX_NONCE,
  ATTR_BLOCKCHAIN_TX_REVERT_REASON,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_TX_TO,
  ATTR_BLOCKCHAIN_TX_VALUE,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_SYSTEM_VALUE_EVM,
  BLOCKCHAIN_TX_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
  BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT,
  ERROR_TYPE_VALUE_OTHER,
} from './attributes.js';
import { LinkStore } from './link-store.js';
import {
  type AddressFormatter,
  formatAddressesIn,
  resolveAddressFormatter,
  resolveErrorMessageMode,
  sanitizeErrorMessage,
} from './privacy.js';
import type {
  ConfirmHandle,
  ConfirmInput,
  ReceiptLike,
  SendHandle,
  SendInput,
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
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_TYPE,
]);

export interface TxTracker {
  /**
   * Starts a `send` span as a child of `parent` (default: the active context).
   * Call `end(hash)` once the transaction hash is known, or `fail(error)`.
   */
  startSend(input: SendInput, parent?: Context): SendHandle;
  /**
   * Starts a `confirm` span for a transaction, linked to its `send` span when known.
   * Parent: `parent` if given, else the active span, else the `send` span's parent.
   */
  startConfirm(input: ConfirmInput, parent?: Context): ConfirmHandle;
}

const NOOP_SEND: SendHandle = { end: () => {}, fail: () => {} };
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

export function createTxTracker(options: TxTrackerOptions = {}): TxTracker {
  const links = new LinkStore({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
  const formatAddress: AddressFormatter = safely(
    'configure address mode',
    () => resolveAddressFormatter(options.address),
    () => undefined,
  );
  const errorMessages = safely(
    'configure error message mode',
    () => resolveErrorMessageMode(options.errorMessages),
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
   * Exception event attributes for `error`, per the error message mode. The error object itself is never handed
   * to the SDK: its message and stack can carry addresses and calldata (docs/adr/0006-error-privacy.md).
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

  const markError = (span: Span, type: string, error?: unknown): void => {
    let message: string | undefined;
    if (error !== undefined) {
      const exception = redact(exceptionAttributes(type, error));
      span.addEvent(EXCEPTION_EVENT, exception);
      const recorded = exception[ATTR_EXCEPTION_MESSAGE];
      if (typeof recorded === 'string') message = recorded;
    }
    span.setAttribute(ATTR_ERROR_TYPE, type);
    span.setStatus({ code: SpanStatusCode.ERROR, ...(message !== undefined ? { message } : {}) });
  };

  /** Ends a span exactly once; the span is always ended even if recording attributes fails. */
  const finisher = (span: Span) => {
    let ended = false;
    return (what: string, record: () => void): void => {
      if (ended) return;
      ended = true;
      try {
        record();
      } catch (error) {
        diag.error(`hashspan: failed to ${what}`, error);
      } finally {
        span.end();
      }
    };
  };

  const setAddress = (attributes: Attributes, key: string, address: string | undefined): void => {
    if (address === undefined) return;
    const formatted = formatAddress(address);
    if (formatted !== undefined) attributes[key] = formatted;
  };

  const baseAttributes = (chainId: number, operation: string, ctx: Context): Attributes => ({
    [ATTR_BLOCKCHAIN_SYSTEM]: BLOCKCHAIN_SYSTEM_VALUE_EVM,
    [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId,
    [ATTR_BLOCKCHAIN_OPERATION_NAME]: operation,
    ...agentAttributes(ctx, options.agent),
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

    const span = getTracer().startSpan(
      `send ${input.chainId}`,
      { kind: SpanKind.CLIENT, attributes: redact(attributes) },
      parent,
    );
    const finish = finisher(span);

    return {
      end: (hash) =>
        finish('record transaction hash', () => {
          links.set(input.chainId, hash, { spanContext: span.spanContext(), parent });
          span.setAttributes(redact({ [ATTR_BLOCKCHAIN_TX_HASH]: hash }));
        }),
      fail: (error) =>
        finish('record send failure', () => markError(span, errorType(error), error)),
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

  const startConfirm = (input: ConfirmInput, parentCtx?: Context): ConfirmHandle => {
    const sent = links.get(input.chainId, input.hash);
    const active = context.active();
    const parent = parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(
      input.chainId,
      BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
      parent,
    );
    attributes[ATTR_BLOCKCHAIN_TX_HASH] = input.hash;
    const spanLinks: Link[] = sent ? [{ context: sent.spanContext }] : [];

    const span = getTracer().startSpan(
      `confirm ${input.chainId}`,
      { kind: SpanKind.CLIENT, attributes: redact(attributes), links: spanLinks },
      parent,
    );
    const finish = finisher(span);

    return {
      end: (receipt) =>
        finish('record receipt', () => {
          span.setAttributes(redact(receiptAttributes(receipt)));
          if (receipt.status === 'reverted') markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
        }),
      timeout: () =>
        finish('record confirmation timeout', () => {
          span.setAttributes(
            redact({ [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT }),
          );
          markError(span, BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT);
        }),
      fail: (error) =>
        finish('record confirmation failure', () => markError(span, errorType(error), error)),
    };
  };

  return {
    startSend: (input, parent) =>
      safely('start send span', () => startSend(input, parent), NOOP_SEND),
    startConfirm: (input, parent) =>
      safely('start confirm span', () => startConfirm(input, parent), NOOP_CONFIRM),
  };
}
