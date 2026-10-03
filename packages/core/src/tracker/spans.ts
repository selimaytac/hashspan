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
  ATTR_BLOCKCHAIN_SYSTEM,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_USER_OPERATION_HASH,
  ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_SYSTEM_VALUE_EVM,
} from '../attributes.js';
import { toEpochMs } from '../metrics.js';
import { type AddressFormatter, formatAddressesIn, sanitizeErrorMessage } from '../privacy.js';
import type { ErrorMessageMode, TxTrackerOptions } from '../types.js';
import { safely } from './handles.js';
import { ADDRESS } from './values.js';

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
  ATTR_BLOCKCHAIN_USER_OPERATION_HASH,
  ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS,
  ATTR_BLOCKCHAIN_CALL_BATCH_ID,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS,
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_TYPE,
]);

/** Attributes of a metric: low-cardinality only, never an address, hash or agent identity. */
export const metricAttributes = (chainId: number, extra: Attributes = {}): Attributes => ({
  [ATTR_BLOCKCHAIN_SYSTEM]: BLOCKCHAIN_SYSTEM_VALUE_EVM,
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0006-error-privacy.md).
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
  ): string => {
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

  /** Records `address` only if it is one: payment and user operation addresses come from remote parties. */
  const setRemoteAddress = (attributes: Attributes, key: string, address: unknown): void => {
    if (typeof address === 'string' && ADDRESS.test(address)) setAddress(attributes, key, address);
  };

  const baseAttributes = (chainId: number, operation: string, ctx: Context): Attributes => ({
    [ATTR_BLOCKCHAIN_SYSTEM]: BLOCKCHAIN_SYSTEM_VALUE_EVM,
    [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId,
    [ATTR_BLOCKCHAIN_OPERATION_NAME]: operation,
    ...agentAttributes(ctx, options.agent, options.agentFromBaggage !== false),
  });

  return { redact, markError, finisher, setAddress, setRemoteAddress, baseAttributes };
}
