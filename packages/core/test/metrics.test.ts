import type { Attributes, Histogram, MeterProvider, MetricOptions } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTxTracker,
  METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
  METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

interface Recorded {
  value: number;
  attributes: Attributes;
}

/** A meter provider that keeps what each histogram records, with the options it was created with. */
function recordingMeterProvider() {
  const recorded = new Map<string, Recorded[]>();
  const options = new Map<string, MetricOptions | undefined>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string, metricOptions?: MetricOptions): Histogram => {
        options.set(name, metricOptions);
        recorded.set(name, []);
        return {
          record: (value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push({ value, attributes });
          },
        };
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [], options };
}

const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const receipt = {
  status: 'success' as const,
  blockNumber: 10n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2_000_000_000n,
  l1Fee: 5n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

describe('metrics', () => {
  it('records the send duration, with error.type when the send failed', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });

    tracker
      .startSend({ chainId: 8453, startTime: new Date(1_000) })
      .end({ hash: HASH }, { endTime: new Date(3_500) });
    tracker
      .startSend({ chainId: 8453, startTime: new Date(1_000) })
      .fail(new TypeError('boom'), { endTime: new Date(1_250) });

    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)).toEqual([
      { value: 2.5, attributes: { 'blockchain.system': 'evm', 'blockchain.chain.id': 8453 } },
      {
        value: 0.25,
        attributes: {
          'blockchain.system': 'evm',
          'blockchain.chain.id': 8453,
          'error.type': 'TypeError',
        },
      },
    ]);
    expect(meters.options.get(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)?.unit).toBe('s');
  });

  it('records the confirmation duration by outcome, and the fee of mined transactions', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    const start = new Date(10_000);

    tracker.startConfirm({ chainId: 1, hash: HASH, startTime: start }).end(receipt, {
      endTime: new Date(22_000),
    });
    tracker
      .startConfirm({ chainId: 1, hash: OTHER_HASH, startTime: start })
      .timeout(new Date(130_000));

    const base = { 'blockchain.system': 'evm', 'blockchain.chain.id': 1 };
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)).toEqual([
      { value: 12, attributes: { ...base, 'blockchain.tx.status': 'success' } },
      { value: 120, attributes: { ...base, 'error.type': 'timeout' } },
    ]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([
      {
        value: 21_000 * 2_000_000_000 + 5,
        attributes: { ...base, 'blockchain.tx.status': 'success' },
      },
    ]);
    expect(meters.options.get(METRIC_BLOCKCHAIN_CLIENT_FEE)?.unit).toBe('{wei}');
  });

  it('records a reverted, failed and replaced confirmation', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });

    tracker.startConfirm({ chainId: 1, hash: HASH }).end({ ...receipt, status: 'reverted' });
    tracker.startConfirm({ chainId: 1, hash: OTHER_HASH }).fail(new RangeError('x'));
    tracker
      .startConfirm({ chainId: 1, hash: `0x${'ef'.repeat(32)}` })
      .end({ ...receipt, transactionHash: `0x${'12'.repeat(32)}` });

    const outcomes = meters
      .recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)
      .map(({ attributes }) => attributes['blockchain.tx.status'] ?? attributes['error.type']);
    // The replacing transaction's receipt is recorded on its own confirm span too.
    expect(outcomes).toEqual(['reverted', 'RangeError', 'replaced', 'success']);
  });

  it('never records addresses, hashes or agent identity', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({
      meterProvider: meters.provider,
      agent: { name: 'treasury-agent', id: 'agent-1' },
    });
    tracker
      .startSend({ chainId: 1, from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}` })
      .end(HASH);
    tracker.startConfirm({ chainId: 1, hash: HASH }).end(receipt);

    for (const name of [
      METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION,
      METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
      METRIC_BLOCKCHAIN_CLIENT_FEE,
    ]) {
      for (const { attributes } of meters.recorded(name)) {
        expect(Object.keys(attributes).sort()).toEqual(
          expect.arrayContaining(['blockchain.chain.id', 'blockchain.system']),
        );
        expect(JSON.stringify(attributes)).not.toMatch(/0x|agent/);
      }
    }
  });

  it('records error.type as an error class or a code, and anything else as _OTHER', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider, redact: () => ({}) });
    const named = (name: string) => Object.assign(new Error('boom'), { name });
    const failSend = (error: unknown, errorType?: string) =>
      tracker.startSend({ chainId: 1 }).fail(error, errorType === undefined ? {} : { errorType });

    failSend(named('TransactionExecutionError'));
    failSend(new Error('plain'));
    failSend(named('Failure_user_42_0x1111111111111111111111111111111111111111'));
    failSend(named('Http500Error'));
    failSend(named('quota exceeded'));
    failSend(new Error('cdp'), 'insufficient_balance');
    failSend(new Error('cdp'), 'code_42');
    tracker.startConfirm({ chainId: 1, hash: HASH }).fail(named('user-42'));
    tracker.startConfirm({ chainId: 1, hash: OTHER_HASH }).timeout();

    const types = (name: string) =>
      meters.recorded(name).map(({ attributes }) => attributes['error.type']);
    expect(types(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)).toEqual([
      'TransactionExecutionError',
      'Error',
      '_OTHER',
      '_OTHER',
      '_OTHER',
      'insufficient_balance',
      '_OTHER',
    ]);
    expect(types(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)).toEqual(['_OTHER', 'timeout']);
  });

  it('keeps the span error.type as it is', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    tracker.startSend({ chainId: 1 }).fail(Object.assign(new Error('x'), { name: 'Failure42' }));
    expect(tracing.spans()[0]?.attributes['error.type']).toBe('Failure42');
    expect(
      meters.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)[0]?.attributes['error.type'],
    ).toBe('_OTHER');
  });

  it('keeps tracing when the meter provider throws', () => {
    const broken = {
      getMeter: () => {
        throw new Error('no meter');
      },
    } as unknown as MeterProvider;
    const tracker = createTxTracker({ meterProvider: broken });

    tracker.startSend({ chainId: 1 }).end(HASH);
    tracker.startConfirm({ chainId: 1, hash: HASH }).end(receipt);
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 1', 'confirm 1']);
    expect(tracing.spanNamed('confirm 1').attributes['blockchain.tx.status']).toBe('success');
  });

  it('accepts span times given as performance.now() values', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    const now = performance.now();
    tracker.startSend({ chainId: 1, startTime: now - 2_000 }).end({ hash: HASH }, { endTime: now });
    const [recorded] = meters.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION);
    expect(recorded?.value).toBeCloseTo(2, 3);
  });
});
