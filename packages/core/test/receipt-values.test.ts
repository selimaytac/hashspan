// Fees, receipt values and receipt-to-hash matching at their edges: each test here fails for a change that records a
// wrong value or attributes a receipt to the wrong transaction (found by mutation testing, issue #207).
import {
  type Attributes,
  diag,
  type Histogram,
  type MeterProvider,
  SpanStatusCode,
} from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTxTracker,
  METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
  type ReceiptLike,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'9f'.repeat(32)}`;
const MINED = `0x${'cd'.repeat(32)}`;
const BUNDLE_HASH = `0x${'b2'.repeat(32)}`;
const USER_OP_HASH = `0x${'a1'.repeat(32)}`;

const receipt: ReceiptLike = {
  status: 'success',
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 1_000_000_000n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const confirmsOf = (hash: string) =>
  tracing
    .spans()
    .filter((s) => s.name === `confirm ${CHAIN_ID}` && s.attributes['blockchain.tx.hash'] === hash);

/** A meter provider that keeps what each histogram records. */
function recordingMeterProvider() {
  const recorded = new Map<string, { value: number; attributes: Attributes }[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return {
          record: (value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push({ value, attributes });
          },
        };
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

describe('receipt values', () => {
  it('ends the confirm span as a failure for a receipt whose block number or gas used cannot be read', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    const malformed = [
      { blockNumber: '123' },
      { blockNumber: Number.NaN },
      { blockNumber: Number.POSITIVE_INFINITY },
      { gasUsed: null },
      { blockNumber: null, gasUsed: null, status: null, effectiveGasPrice: null },
    ];
    malformed.forEach((values, i) => {
      tracker
        .startConfirm({ chainId: CHAIN_ID, hash: `0x${String(i).padStart(64, '0')}` })
        .end({ ...receipt, ...values } as never);
    });
    expect(tracing.spans()).toHaveLength(malformed.length);
    for (const span of tracing.spans()) {
      expect(span.attributes['blockchain.block.number']).toBeUndefined();
      expect(span.attributes['blockchain.tx.status']).toBeUndefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('_OTHER');
    }
    // One confirmation sample each, as a failure; no fee.
    expect(
      meters
        .recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)
        .map(({ attributes }) => attributes['error.type']),
    ).toEqual(malformed.map(() => '_OTHER'));
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(malformed.length);
  });

  it('lets a later wait record the receipt after one that could not be read (#311)', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const tracker = createTxTracker();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, gasUsed: null } as never);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirmsOf(HASH).map((span) => span.attributes['blockchain.tx.status'])).toEqual([
      undefined,
      'success',
    ]);
  });

  it('records a block number and gas used given as numbers', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, blockNumber: 123, gasUsed: 21_000 });
    expect(confirmsOf(HASH)[0]?.attributes).toMatchObject({
      'blockchain.block.number': 123,
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.fee': '21000000000000',
    });
  });

  it('records no fee and logs no error for a receipt without an effective gas price', () => {
    const error = vi.spyOn(diag, 'error');
    const meters = recordingMeterProvider();
    createTxTracker({ meterProvider: meters.provider })
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, effectiveGasPrice: undefined, l1Fee: 7n });
    const [span] = confirmsOf(HASH);
    expect(span?.attributes['blockchain.tx.status']).toBe('success');
    expect(span?.attributes['blockchain.tx.l1_fee']).toBe('7');
    expect(span?.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('receipt to hash matching', () => {
  it('ends the span as unattributable for a receipt hash that is not a string, even one that reads as a hash', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(diag, 'error');
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: [HASH] as never });
    const [span] = confirmsOf(HASH);
    expect(span?.attributes['error.type']).toBe('_OTHER');
    expect(span?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('settles the awaited transaction once its own receipt is recorded, until the link TTL passes', () => {
    vi.useFakeTimers();
    try {
      const tracker = createTxTracker({ linkTtlMs: 1_000 });
      tracker
        .startConfirm({ chainId: CHAIN_ID, hash: HASH })
        .end({ ...receipt, transactionHash: HASH });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      expect(confirmsOf(HASH)).toHaveLength(1);
      vi.advanceTimersByTime(1_001);
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      expect(confirmsOf(HASH)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs no error when a wait starts for a transaction that recently got its receipt', () => {
    const error = vi.spyOn(diag, 'error');
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    const late = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    late.end(receipt);
    late.timeout();
    expect(confirmsOf(HASH)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('replacing transactions', () => {
  const replaced = { ...receipt, transactionHash: MINED, replacementReason: 'repriced' as const };

  it('settles the replacing transaction, so a later wait for it adds no span', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replaced);
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: MINED })
      .end({ ...receipt, transactionHash: MINED });
    expect(confirmsOf(HASH)).toHaveLength(1);
    expect(confirmsOf(MINED)).toHaveLength(1);
  });

  it('settles both transactions until the link TTL passes, then traces them again', () => {
    vi.useFakeTimers();
    try {
      const tracker = createTxTracker({ linkTtlMs: 1_000 });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replaced);
      vi.advanceTimersByTime(1_001);
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      tracker
        .startConfirm({ chainId: CHAIN_ID, hash: MINED })
        .end({ ...receipt, transactionHash: MINED });
      expect(confirmsOf(HASH)).toHaveLength(2);
      expect(confirmsOf(MINED)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a waiting confirm span of the replacing transaction, until the link TTL passes', () => {
    vi.useFakeTimers();
    try {
      const tracker = createTxTracker({ linkTtlMs: 1_000 });
      const waiting = tracker.startConfirm({ chainId: CHAIN_ID, hash: MINED });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replaced);
      waiting.end({ ...receipt, transactionHash: MINED });
      expect(confirmsOf(MINED)).toHaveLength(1);
      vi.advanceTimersByTime(1_001);
      tracker
        .startConfirm({ chainId: CHAIN_ID, hash: MINED })
        .end({ ...receipt, transactionHash: MINED });
      expect(confirmsOf(MINED)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records nothing more, and logs no error, when the replacing transaction already got its receipt', () => {
    const error = vi.spyOn(diag, 'error');
    const tracker = createTxTracker();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: MINED })
      .end({ ...receipt, transactionHash: MINED });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replaced);
    expect(confirmsOf(MINED)).toHaveLength(1);
    expect(confirmsOf(HASH)[0]?.attributes['blockchain.tx.status']).toBe('replaced');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('user operation receipt values', () => {
  const confirmUserOperation = (
    values: Record<string, unknown>,
    options: Parameters<typeof createTxTracker>[0] = {},
  ) => {
    createTxTracker(options)
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end(values as never);
    return tracing.spanNamed(`confirm ${CHAIN_ID}`);
  };

  it('records quantities at the largest values it accepts', () => {
    const span = confirmUserOperation({
      actualGasCost: `0x${'f'.repeat(64)}`,
      actualGasUsed: Number.MAX_SAFE_INTEGER,
    });
    expect(span.attributes).toMatchObject({
      'blockchain.user_operation.gas.cost': (2n ** 256n - 1n).toString(),
      'blockchain.user_operation.gas.used': Number.MAX_SAFE_INTEGER,
    });
  });

  it('leaves out a gas cost given as an unsafe or fractional number, and keeps the other values', () => {
    for (const actualGasCost of [2 ** 60, 1.5]) {
      tracing.exporter.reset();
      const span = confirmUserOperation({ success: true, actualGasCost, actualGasUsed: 5 });
      expect(span.attributes['blockchain.user_operation.gas.cost']).toBeUndefined();
      expect(span.attributes).toMatchObject({
        'blockchain.user_operation.success': true,
        'blockchain.user_operation.gas.used': 5,
      });
    }
  });

  it('leaves out a quantity given as a string that is no number, and keeps the other values', () => {
    for (const malformed of ['abc', '0xnope', '-1']) {
      tracing.exporter.reset();
      const span = confirmUserOperation({
        success: true,
        actualGasCost: malformed,
        nonce: malformed,
        actualGasUsed: 5,
      });
      expect(span.attributes['blockchain.user_operation.gas.cost']).toBeUndefined();
      expect(span.attributes['blockchain.user_operation.nonce']).toBeUndefined();
      expect(span.attributes).toMatchObject({
        'blockchain.user_operation.success': true,
        'blockchain.user_operation.gas.used': 5,
      });
    }
  });

  it('records no bundle hash that is not a string', () => {
    const span = confirmUserOperation({ success: true, transactionHash: [BUNDLE_HASH] });
    expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(span.attributes['blockchain.user_operation.success']).toBe(true);
  });

  it('hands the redaction hook only the values it records', () => {
    const seen: string[][] = [];
    confirmUserOperation(
      { success: true, actualGasUsed: 'x', blockNumber: 'y' },
      {
        redact: (attributes) => {
          seen.push(Object.keys(attributes));
          return attributes;
        },
      },
    );
    const receiptKeys = seen.at(-1) ?? [];
    expect(receiptKeys).toContain('blockchain.user_operation.success');
    expect(receiptKeys).not.toContain('blockchain.user_operation.gas.used');
    expect(receiptKeys).not.toContain('blockchain.block.number');
  });

  it('records no fee, no success flag in the metrics and no error without a cost and a success flag', () => {
    const error = vi.spyOn(diag, 'error');
    const meters = recordingMeterProvider();
    confirmUserOperation({ transactionHash: BUNDLE_HASH }, { meterProvider: meters.provider });
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([]);
    const [duration] = meters.recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION);
    expect(Object.keys(duration?.attributes ?? {})).not.toContain(
      'blockchain.user_operation.success',
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe('payment amounts', () => {
  it('records no amount given as a number', () => {
    createTxTracker()
      .startPayment({ chainId: CHAIN_ID, protocol: 'x402', amount: 10_000 as never })
      .fail(new Error('declined'));
    const span = tracing.spanNamed(`payment ${CHAIN_ID}`);
    expect(span.attributes['blockchain.payment.amount']).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});
