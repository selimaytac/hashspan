import {
  type Attributes,
  DiagLogLevel,
  diag,
  type Histogram,
  type MeterProvider,
  type MetricOptions,
  metrics,
} from '@opentelemetry/api';
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
      {
        value: 2.5,
        attributes: {
          'blockchain.system': 'evm',
          'blockchain.system.name': 'evm',
          'blockchain.chain.id': 8453,
        },
      },
      {
        value: 0.25,
        attributes: {
          'blockchain.system': 'evm',
          'blockchain.system.name': 'evm',
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

    const base = {
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': 1,
    };
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

  it("records an adapter's error type of a confirmation, without an exception event when there is no error", () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });

    // A transaction a chain reorganisation removed (docs/adr/0026-receipt-after-several-confirmations.md).
    tracker
      .startConfirm({ chainId: 1, hash: HASH })
      .fail(undefined, { endTime: new Date(), errorType: 'not_on_chain' });
    tracker
      .startConfirm({ chainId: 1, hash: OTHER_HASH })
      .fail(new RangeError('x'), { errorType: 'not_on_chain' });

    expect(
      meters
        .recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)
        .map(({ attributes }) => [attributes['error.type'], attributes['blockchain.tx.status']]),
    ).toEqual([
      ['not_on_chain', undefined],
      ['not_on_chain', undefined],
    ]);
    const [removed, failed] = tracing.spans();
    expect(removed?.attributes['error.type']).toBe('not_on_chain');
    expect(removed?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(removed?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(removed?.events).toEqual([]);
    // With an error, the exception event keeps the error's class name.
    expect(failed?.events[0]?.attributes?.['exception.type']).toBe('RangeError');
  });

  it("records who paid a fee that the sender did not: a payment's facilitator, or a paymaster", () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    const fees = () =>
      meters
        .recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)
        .map(({ attributes }) => attributes['blockchain.fee.payer']);

    // A transaction of the agent's own.
    tracker.startSend({ chainId: 1 }).end({ hash: HASH });
    tracker.startConfirm({ chainId: 1, hash: HASH }).end(receipt);
    // The settlement transaction of a payment, sent by the facilitator.
    const payment = tracker.startPayment({ chainId: 1, protocol: 'x402', amount: 1n });
    payment.link(OTHER_HASH);
    tracker.startConfirm({ chainId: 1, hash: OTHER_HASH }).end(receipt);
    payment.end({ status: 'settled', hash: OTHER_HASH });
    // A settlement replaced by the facilitator: the replacing transaction's fee is the facilitator's too.
    const replaced = `0x${'ef'.repeat(32)}`;
    const second = tracker.startPayment({ chainId: 1, protocol: 'x402', amount: 1n });
    second.link(replaced);
    tracker
      .startConfirm({ chainId: 1, hash: replaced })
      .end({ ...receipt, transactionHash: `0x${'12'.repeat(32)}` });
    second.end({ status: 'settled', hash: replaced });
    // User operations with and without a paymaster.
    const operation = {
      success: true,
      actualGasCost: 1_000n,
      actualGasUsed: 10n,
      transactionHash: `0x${'34'.repeat(32)}`,
      blockNumber: 1n,
    };
    tracker
      .startUserOperationConfirm({ chainId: 1, userOpHash: `0x${'56'.repeat(32)}` })
      .end(operation);
    tracker
      .startUserOperationConfirm({ chainId: 1, userOpHash: `0x${'78'.repeat(32)}` })
      .end({ ...operation, paymaster: '0x3333333333333333333333333333333333333333' });
    tracker
      .startUserOperationConfirm({ chainId: 1, userOpHash: `0x${'9a'.repeat(32)}` })
      .end({ ...operation, paymaster: `0x${'00'.repeat(20)}` });

    expect(fees()).toEqual([
      undefined,
      'facilitator',
      'facilitator',
      undefined,
      'paymaster',
      undefined,
    ]);
    // Only the fee sample says who paid: the confirmation durations stay as they were.
    expect(
      meters
        .recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)
        .some(({ attributes }) => 'blockchain.fee.payer' in attributes),
    ).toBe(false);
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

describe('metrics through the global meter provider', () => {
  afterEach(() => {
    metrics.disable();
    diag.disable();
  });

  it('are recorded from the first transaction after a meter provider is registered late', () => {
    const debug: string[] = [];
    diag.setLogger(
      {
        debug: (message: string) => debug.push(message),
        verbose: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      DiagLogLevel.DEBUG,
    );
    const tracker = createTxTracker();

    // Before an SDK registers a meter provider: the global one is the no-op provider.
    tracker.startSend({ chainId: 1 }).end({ hash: HASH });
    tracker.startSend({ chainId: 1 }).end({ hash: OTHER_HASH });
    const meters = recordingMeterProvider();
    metrics.setGlobalMeterProvider(meters.provider);
    tracker.startSend({ chainId: 2 }).end({ hash: HASH });
    tracker.startConfirm({ chainId: 2, hash: HASH }).end(receipt);

    expect(
      meters
        .recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)
        .map(({ attributes }) => attributes['blockchain.chain.id']),
    ).toEqual([2]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)).toHaveLength(1);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toHaveLength(1);
    // One debug line, however many transactions came before.
    expect(debug.filter((message) => message.includes('meter provider'))).toHaveLength(1);
  });

  it('keeps the histograms of the first registered provider', () => {
    const first = recordingMeterProvider();
    metrics.setGlobalMeterProvider(first.provider);
    const tracker = createTxTracker();
    tracker.startSend({ chainId: 1 }).end({ hash: HASH });
    metrics.disable();
    const second = recordingMeterProvider();
    metrics.setGlobalMeterProvider(second.provider);
    tracker.startSend({ chainId: 1 }).end({ hash: OTHER_HASH });

    expect(first.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)).toHaveLength(2);
    expect(second.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)).toHaveLength(0);
  });
});
