// Recording spans: redaction, errors, ending a span once, address attributes and metric attributes.
import {
  type Attributes,
  type Context,
  diag,
  type Span,
  SpanStatusCode,
  type TimeInput,
} from '@opentelemetry/api';
import { agentAttributes } from '../agent.js';
import {
  ATTR_BLOCKCHAIN_CALL_BATCH_ID,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL,
  ATTR_BLOCKCHAIN_PAYMENT_STATUS,
  ATTR_BLOCKCHAIN_PAYMENT_VERIFIED,
  ATTR_BLOCKCHAIN_SYSTEM_NAME,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_USER_OPERATION_HASH,
  ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_SYSTEM_VALUE_EVM,
  ERROR_TYPE_VALUE_OTHER,
} from '../attributes.js';
import { toEpochMs } from '../metrics.js';
import { type AddressFormatter, formatAddressesIn, sanitizeErrorMessage } from '../privacy.js';
import type { ErrorMessageMode, TxTrackerOptions } from '../types.js';
import { errorType, safely } from './handles.js';
import { ADDRESS, identifier, ownValue } from './values.js';

/** OpenTelemetry exception event and attributes. */
const EXCEPTION_EVENT = 'exception';
const ATTR_EXCEPTION_TYPE = 'exception.type';
const ATTR_EXCEPTION_MESSAGE = 'exception.message';
const ATTR_EXCEPTION_STACKTRACE = 'exception.stacktrace';

/** Attributes kept when the redaction hook fails (fail closed). */
const NON_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  ATTR_BLOCKCHAIN_SYSTEM_NAME,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON,
  ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL,
  ATTR_BLOCKCHAIN_PAYMENT_STATUS,
  ATTR_BLOCKCHAIN_PAYMENT_VERIFIED,
  ATTR_BLOCKCHAIN_USER_OPERATION_HASH,
  ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS,
  ATTR_BLOCKCHAIN_CALL_BATCH_ID,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS,
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_TYPE,
]);

// The system of every span and metric sample.
const SYSTEM: Attributes = { [ATTR_BLOCKCHAIN_SYSTEM_NAME]: BLOCKCHAIN_SYSTEM_VALUE_EVM };

/** Attributes of a metric: low-cardinality only, never an address, hash or agent identity. */
export const metricAttributes = (chainId: number, extra: Attributes = {}): Attributes => ({
  ...SYSTEM,
  [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId,
  ...extra,
});

export const secondsSince = (startMs: number, endTime: TimeInput | undefined): number =>
  (toEpochMs(endTime) - startMs) / 1000;

/** What the tracker of one `createTxTracker()` call needs to record spans. */
export interface SpanRecordingDependencies {
  options: TxTrackerOptions;
  formatAddress: AddressFormatter;
  errorMessages: ErrorMessageMode;
}

/** Recording helpers bound to the options of one `createTxTracker()` call. */
export interface SpanRecording {
  redact(attributes: Attributes): Attributes;
  markError(span: Span, errorName: string, error?: unknown, exceptionName?: string): string;
  finisher(span: Span): (what: string, record: () => void, endTime?: TimeInput) => void;
  setAddress(attributes: Attributes, key: string, address: string | undefined): void;
  setRemoteAddress(attributes: Attributes, key: string, address: unknown): void;
  baseAttributes(chainId: number, operation: string, ctx: Context): Attributes;
}

/** Creates the recording helpers of one tracker. */
export function createSpanRecording({
  options,
  formatAddress,
  errorMessages,
}: SpanRecordingDependencies): SpanRecording {
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.12.0/docs/adr/0006-error-privacy.md).
   */
  const exceptionAttributes = (type: string, error: unknown): Attributes => {
    const attributes: Attributes = { [ATTR_EXCEPTION_TYPE]: type };
    if (errorMessages === 'off') return attributes;
    const message = messageOf(error);
    if (message === undefined) return attributes;
    if (errorMessages === 'sanitized') {
      const sanitized = sanitizeErrorMessage(message, formatAddress);
      if (sanitized) attributes[ATTR_EXCEPTION_MESSAGE] = sanitized;
      return attributes;
    }
    attributes[ATTR_EXCEPTION_MESSAGE] = message;
    const stack = stackOf(error);
    if (stack) attributes[ATTR_EXCEPTION_STACKTRACE] = stack;
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
  ): string => {
    // Checked here too, so no caller can record free text as a type (ADR 0025).
    const type = formatAddressesIn(identifier(errorName) ?? ERROR_TYPE_VALUE_OTHER, formatAddress);
    // The failure is recorded first, so an exception event that cannot be built never hides it.
    span.setAttributes(redact({ [ATTR_ERROR_TYPE]: type }));
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (error !== undefined) {
      const exceptionType = formatAddressesIn(
        identifier(exceptionName) ?? ERROR_TYPE_VALUE_OTHER,
        formatAddress,
      );
      const exception = redact(exceptionAttributes(exceptionType, error));
      span.addEvent(EXCEPTION_EVENT, exception);
      const recorded = exception[ATTR_EXCEPTION_MESSAGE];
      if (typeof recorded === 'string') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: recorded });
      }
    }
    return type;
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
        // The name only: what was thrown can be the caller's error, with addresses and URLs in its message.
        diag.error(`hashspan: failed to ${what}: ${errorType(error)}`);
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

  /** Records `address` only if it is one: payment and user operation addresses come from remote parties. */
  const setRemoteAddress = (attributes: Attributes, key: string, address: unknown): void => {
    if (typeof address === 'string' && ADDRESS.test(address)) setAddress(attributes, key, address);
  };

  const baseAttributes = (chainId: number, operation: string, ctx: Context): Attributes => ({
    ...SYSTEM,
    [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId,
    [ATTR_BLOCKCHAIN_OPERATION_NAME]: operation,
    ...agentAttributes(ctx, options.agent, options.agentFromBaggage !== false),
  });

  return { redact, markError, finisher, setAddress, setRemoteAddress, baseAttributes };
}

/**
 * The message of `error`: an Error's `message`, or a primitive thrown as is. The own data property is read first;
 * otherwise `message` is read normally (a `DOMException` has an accessor), and a read that throws gives no message.
 */
function messageOf(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'bigint' || typeof error === 'boolean') {
    return String(error);
  }
  try {
    if (!(error instanceof Error)) return undefined;
    const own = ownValue(error, 'message');
    const message: unknown = own !== undefined ? own : error.message;
    return typeof message === 'string' ? message : undefined;
  } catch {
    // A Proxy can throw from its traps.
    return undefined;
  }
}

/** The stack of `error`, if it is an Error with a readable string stack. */
function stackOf(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const stack: unknown = error.stack;
    return typeof stack === 'string' ? stack : undefined;
  } catch {
    return undefined;
  }
}
