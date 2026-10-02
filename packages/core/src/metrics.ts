import {
  type Attributes,
  diag,
  type Histogram,
  type MeterProvider,
  metrics,
  type TimeInput,
} from '@opentelemetry/api';

/** Duration of a send: from the start of the sending call until the hash is known or the call failed. */
export const METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION = 'blockchain.client.send.duration' as const;
/** Duration of a confirmation: from the start of the wait until the receipt, a timeout or a failure. */
export const METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION =
  'blockchain.client.confirmation.duration' as const;
/** Total fee of a mined transaction (execution fee plus L1 data fee), in the chain's smallest unit (wei). */
export const METRIC_BLOCKCHAIN_CLIENT_FEE = 'blockchain.client.fee' as const;

// Seconds: block times range from under a second to minutes, and confirmations time out after two minutes by default.
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
// Wei, one bucket per power of ten: fees range from fractions of a gwei on L2s to fractions of an ether on L1.
const FEE_BUCKETS = Array.from({ length: 11 }, (_, i) => 10 ** (i + 8));

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
  const get = () => {
    histograms ??= (() => {
      const meter = (meterProvider ?? metrics.getMeterProvider()).getMeter(name, version);
      return {
        send: meter.createHistogram(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION, {
          unit: 's',
          description: 'Duration of sending a transaction, until its hash is known',
          advice: { explicitBucketBoundaries: DURATION_BUCKETS },
        }),
        confirmation: meter.createHistogram(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION, {
          unit: 's',
          description: 'Duration of waiting for a transaction receipt',
          advice: { explicitBucketBoundaries: DURATION_BUCKETS },
        }),
        fee: meter.createHistogram(METRIC_BLOCKCHAIN_CLIENT_FEE, {
          unit: '{wei}',
          description: 'Total fee of a mined transaction',
          advice: { explicitBucketBoundaries: FEE_BUCKETS },
        }),
      };
    })();
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
        if (seconds >= 0) get().send.record(seconds, attributes);
      }),
    confirmationDuration: (seconds, attributes) =>
      record('confirmation duration', () => {
        if (seconds >= 0) get().confirmation.record(seconds, attributes);
      }),
    fee: (wei, attributes) =>
      record('fee', () => {
        if (wei >= 0n) get().fee.record(Number(wei), attributes);
      }),
  };
}
