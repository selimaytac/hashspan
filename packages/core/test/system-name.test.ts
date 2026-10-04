import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_BLOCKCHAIN_SYSTEM,
  ATTR_BLOCKCHAIN_SYSTEM_NAME,
  BLOCKCHAIN_SYSTEM_VALUE_EVM,
  createTxTracker,
  METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
  METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION,
  type TxTracker,
  type TxTrackerOptions,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

// blockchain.system is renamed to blockchain.system.name: until 1.0 every span and metric sample that records the
// old name records the new one too, with the same value (docs/semconv.md, change policy).

/** A meter provider that keeps the attributes of every sample, per histogram. */
function recordingMeterProvider() {
  const recorded = new Map<string, Attributes[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return {
          record: (_value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push(attributes);
          },
        } as Histogram;
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

const hash = (byte: string) => `0x${byte.repeat(32)}`;
const receipt = {
  status: 'success' as const,
  blockNumber: 10n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2_000_000_000n,
};
const operation = {
  success: true,
  actualGasCost: 1_000n,
  actualGasUsed: 10n,
  transactionHash: hash('34'),
  blockNumber: 1n,
};

/** Sends and confirms each subject with each kind of outcome, and records a payment. */
function exercise(tracker: TxTracker): void {
  // Transactions: sent, failed, mined, reverted, timed out, replaced.
  tracker.startSend({ chainId: 1 }).end({ hash: hash('01') });
  tracker.startSend({ chainId: 1 }).fail(new TypeError('boom'));
  tracker.startConfirm({ chainId: 1, hash: hash('01') }).end(receipt);
  tracker.startConfirm({ chainId: 1, hash: hash('02') }).end({ ...receipt, status: 'reverted' });
  tracker.startConfirm({ chainId: 1, hash: hash('03') }).timeout();
  tracker
    .startConfirm({ chainId: 1, hash: hash('04') })
    .end({ ...receipt, transactionHash: hash('05') });
  // A payment and its settlement, whose fee sample says who paid.
  const payment = tracker.startPayment({ chainId: 1, protocol: 'x402', amount: 1n });
  payment.link(hash('06'));
  tracker.startConfirm({ chainId: 1, hash: hash('06') }).end(receipt);
  payment.end({ status: 'settled', hash: hash('06') });
  // User operations: sent, failed, confirmed with and without a paymaster, reverted.
  tracker.startUserOperationSend({ chainId: 1 }).end({ userOpHash: hash('07') });
  tracker.startUserOperationSend({ chainId: 1 }).fail(new TypeError('boom'));
  tracker.startUserOperationConfirm({ chainId: 1, userOpHash: hash('07') }).end(operation);
  tracker
    .startUserOperationConfirm({ chainId: 1, userOpHash: hash('08') })
    .end({ ...operation, paymaster: `0x${'33'.repeat(20)}` });
  tracker
    .startUserOperationConfirm({ chainId: 1, userOpHash: hash('09') })
    .end({ ...operation, success: false });
  // Call batches: sent, failed, confirmed, failed without inclusion.
  tracker.startCallBatchSend({ chainId: 1 }).end({ id: '0xba7c' });
  tracker.startCallBatchSend({ chainId: 1 }).fail(new TypeError('boom'));
  tracker.startCallBatchConfirm({ chainId: 1, id: '0xba7c' }).end({ statusCode: 200 });
  tracker.startCallBatchConfirm({ chainId: 1, id: '0xba7d' }).end({ statusCode: 400 });
}

const METRICS = [
  METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
];

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

describe('blockchain.system.name', () => {
  it('names the new attribute and keeps the old one', () => {
    expect(ATTR_BLOCKCHAIN_SYSTEM_NAME).toBe('blockchain.system.name');
    expect(ATTR_BLOCKCHAIN_SYSTEM).toBe('blockchain.system');
  });

  it.each<[string, TxTrackerOptions]>([
    ['by default', {}],
    [
      'when the redaction hook throws',
      {
        redact: () => {
          throw new Error('redaction failed');
        },
      },
    ],
  ])('is on every span and every metric sample with the old name, %s', (_, options) => {
    const meters = recordingMeterProvider();
    exercise(createTxTracker({ ...options, meterProvider: meters.provider }));

    const spans = tracing.spans();
    const operations = new Set(spans.map((span) => span.attributes['blockchain.operation.name']));
    expect(operations).toEqual(new Set(['send', 'confirm', 'payment']));
    for (const span of spans) {
      expect(span.attributes[ATTR_BLOCKCHAIN_SYSTEM_NAME], span.name).toBe(
        BLOCKCHAIN_SYSTEM_VALUE_EVM,
      );
      expect(span.attributes[ATTR_BLOCKCHAIN_SYSTEM], span.name).toBe(BLOCKCHAIN_SYSTEM_VALUE_EVM);
    }

    for (const name of METRICS) {
      const samples = meters.recorded(name);
      expect(samples.length, name).toBeGreaterThan(0);
      for (const attributes of samples) {
        expect(attributes[ATTR_BLOCKCHAIN_SYSTEM_NAME], name).toBe(BLOCKCHAIN_SYSTEM_VALUE_EVM);
        expect(attributes[ATTR_BLOCKCHAIN_SYSTEM], name).toBe(BLOCKCHAIN_SYSTEM_VALUE_EVM);
      }
    }
    // Each subject, and a fee another party paid, is among the samples.
    const all = METRICS.flatMap((name) => meters.recorded(name));
    expect(new Set(all.map((attributes) => attributes['blockchain.operation.subject']))).toEqual(
      new Set([undefined, 'user_operation', 'call_batch']),
    );
    expect(
      new Set(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE).map((a) => a['blockchain.fee.payer'])),
    ).toEqual(new Set([undefined, 'facilitator', 'paymaster']));
  });
});
