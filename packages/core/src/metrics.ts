import {
  type Attributes,
  createNoopMeter,
  diag,
  type Histogram,
  type MeterProvider,
  metrics,
  type TimeInput,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE, ERROR_TYPE_VALUE_OTHER } from './attributes.js';

/**
 * Duration of a send of a transaction or user operation: from the start of the sending call until the hash is known or
 * the call failed.
 */
export const METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION = 'blockchain.client.send.duration' as const;
/**
 * Duration of a confirmation of a transaction or user operation: from the start of the wait until the receipt, a
 * timeout or a failure.
 */
export const METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION =
  'blockchain.client.confirmation.duration' as const;
/**
 * Total fee of a mined transaction (execution fee plus L1 data fee), or the cost of a user operation, in the chain's
 * smallest unit (wei).
 */
export const METRIC_BLOCKCHAIN_CLIENT_FEE = 'blockchain.client.fee' as const;

// Seconds: block times range from under a second to minutes, and confirmations time out after two minutes by default.
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
// Wei, one bucket per power of ten: fees range from fractions of a gwei on L2s to fractions of an ether on L1.
const FEE_BUCKETS = Array.from({ length: 11 }, (_, i) => 10 ** (i + 8));

// error.type values kept on metrics: an error class name (letters only, such as viem's `TransactionExecutionError`)
// or a lower-case code (`timeout`, `reverted`, an adapter's code such as `insufficient_balance`). Neither can hold an
// address, a hash or a number, so the label stays low-cardinality.
const ERROR_CLASS = /^[A-Z][A-Za-z]{0,62}Error$|^Error$/;
const ERROR_CODE = /^[a-z]{1,32}(_[a-z]{1,32}){0,7}$/;

/**
 * `attributes` with `error.type` kept only if it is an error class name or a lower-case code, else `_OTHER`. Error
 * names are free text (any `Error.name`), and metrics do not pass through the `redact` hook; the span keeps its own
 * `error.type`.
 */
function withMetricErrorType(attributes: Attributes): Attributes {
  const type = attributes[ATTR_ERROR_TYPE];
  if (type === undefined) return attributes;
  const kept =
    typeof type === 'string' &&
    (type === ERROR_TYPE_VALUE_OTHER || ERROR_CLASS.test(type) || ERROR_CODE.test(type));
  return kept ? attributes : { ...attributes, [ATTR_ERROR_TYPE]: ERROR_TYPE_VALUE_OTHER };
}

/** Records the tracker's histograms; never throws. */
export interface TxMetrics {
  sendDuration(seconds: number, attributes: Attributes): void;
  confirmationDuration(seconds: number, attributes: Attributes): void;
  fee(wei: bigint, attributes: Attributes): void;
}

/** Milliseconds since the epoch of a span time, as the OpenTelemetry API accepts it. */
export function toEpochMs(time: TimeInput | undefined): number {
  if (time === undefined) return Date.now();
  if (time instanceof Date) return time.getTime();
  if (Array.isArray(time)) return time[0] * 1000 + time[1] / 1e6;
  if (typeof time !== 'number') return Date.now();
  // Like the OpenTelemetry SDK, a number before the time origin is relative to it (a `performance.now()` value).
  const origin = (globalThis as { performance?: { timeOrigin?: number } }).performance?.timeOrigin;
  return typeof origin === 'number' && time < origin ? origin + time : time;
}

export function createTxMetrics(
  meterProvider: MeterProvider | undefined,
  name: string,
  version: string,
): TxMetrics {
  let histograms: { send: Histogram; confirmation: Histogram; fee: Histogram } | undefined;
  let waitingReported = false;
  /**
   * The histograms, created at the first transaction and kept. The global meter provider has no proxy: until an SDK
   * registers one, it is the no-op provider, whose instruments stay no-op. Those are not kept, and the global provider
   * is asked again at the next transaction (#379).
   */
  const get = () => {
    if (histograms) return histograms;
    const meter = (meterProvider ?? metrics.getMeterProvider()).getMeter(name, version);
    const created = {
      send: meter.createHistogram(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION, {
        unit: 's',
        description: 'Duration of sending a transaction or user operation, until its hash is known',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      }),
      confirmation: meter.createHistogram(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION, {
        unit: 's',
        description: 'Duration of waiting for a transaction or user operation receipt',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      }),
      fee: meter.createHistogram(METRIC_BLOCKCHAIN_CLIENT_FEE, {
        unit: '{wei}',
        description: 'Total fee of a mined transaction, or the cost of a user operation',
        advice: { explicitBucketBoundaries: FEE_BUCKETS },
      }),
    };
    // The no-op provider of @opentelemetry/api answers every getMeter() with one no-op meter, which createNoopMeter()
    // returns too.
    if (meterProvider === undefined && meter === createNoopMeter()) {
      if (!waitingReported) {
        waitingReported = true;
        diag.debug(
          'hashspan: no global meter provider yet; metrics are recorded once one is registered',
        );
      }
      return created;
    }
    histograms = created;
    return histograms;
  };
  const record = (what: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      diag.error(`hashspan: failed to record the ${what} metric`, error);
    }
  };
  return {
    sendDuration: (seconds, attributes) =>
      record('send duration', () => {
        if (seconds >= 0) get().send.record(seconds, withMetricErrorType(attributes));
      }),
    confirmationDuration: (seconds, attributes) =>
      record('confirmation duration', () => {
        if (seconds >= 0) get().confirmation.record(seconds, withMetricErrorType(attributes));
      }),
    fee: (wei, attributes) =>
      record('fee', () => {
        if (wei >= 0n) get().fee.record(Number(wei), attributes);
      }),
  };
}
