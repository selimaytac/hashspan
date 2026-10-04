import {
  type Attributes,
  context,
  type Histogram,
  type MeterProvider,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTxTracker,
  METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
  METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION,
  type UserOperationReceiptLike,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 84532;
const USER_OP_HASH = `0x${'a1'.repeat(32)}`;
const BUNDLE_HASH = `0x${'b2'.repeat(32)}`;
const SENDER = '0x1111111111111111111111111111111111111111';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const PAYMASTER = '0x3333333333333333333333333333333333333333';
/** A 4337 nonce: key 1 in the upper 192 bits, sequence number 5. */
const NONCE = (1n << 64n) | 5n;

const receipt: UserOperationReceiptLike = {
  success: true,
  actualGasCost: 123_456_789_000n,
  actualGasUsed: 98_765n,
  sender: SENDER,
  nonce: `0x${NONCE.toString(16)}`,
  entryPoint: ENTRY_POINT,
  transactionHash: BUNDLE_HASH,
  blockNumber: 42n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const send = `send ${CHAIN_ID}`;
const confirm = `confirm ${CHAIN_ID}`;

describe('user operation send span', () => {
  it('is a CLIENT child of the active span with the sender, EntryPoint, call count and hash', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    let active: unknown;
    context.with(trace.setSpan(context.active(), tool), () => {
      const handle = tracker.startUserOperationSend({
        chainId: CHAIN_ID,
        sender: SENDER,
        entryPoint: ENTRY_POINT,
        callCount: 2,
      });
      active = trace.getSpan(handle.context);
      handle.end({ userOpHash: USER_OP_HASH });
    });
    tool.end();

    const span = tracing.spanNamed(send);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect((active as { spanContext(): { spanId: string } }).spanContext().spanId).toBe(
      span.spanContext().spanId,
    );
    expect(span.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'send',
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.entry_point': ENTRY_POINT.toLowerCase(),
      'blockchain.user_operation.call_count': 2,
      'blockchain.user_operation.hash': USER_OP_HASH,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records no hash, and links nothing, when the bundler returned none that is valid', () => {
    const tracker = createTxTracker();
    for (const userOpHash of ['0x1234', 42, undefined]) {
      tracker
        .startUserOperationSend({ chainId: CHAIN_ID })
        .end({ userOpHash } as unknown as { userOpHash: string });
    }
    tracker.startUserOperationSend({ chainId: CHAIN_ID }).end(undefined as never);
    expect(tracing.spans()).toHaveLength(4);
    for (const span of tracing.spans()) {
      expect(span.attributes['blockchain.user_operation.hash']).toBeUndefined();
    }
  });

  it('leaves out an invalid sender, EntryPoint or call count', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationSend({
        chainId: CHAIN_ID,
        sender: 'not an address',
        entryPoint: '0x12',
        callCount: -1,
      })
      .end({ userOpHash: USER_OP_HASH });
    tracker.startUserOperationSend({ chainId: CHAIN_ID, callCount: 1.5 }).end({
      userOpHash: USER_OP_HASH,
    });
    for (const span of tracing.spans()) {
      expect(Object.keys(span.attributes).sort()).toEqual([
        'blockchain.chain.id',
        'blockchain.operation.name',
        'blockchain.system',
        'blockchain.system.name',
        'blockchain.user_operation.hash',
      ]);
    }
  });

  it('records a failure, with the error type an adapter reports', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationSend({ chainId: CHAIN_ID })
      .fail(new TypeError('AA21 didnt pay prefund'), { errorType: 'AA21' });
    const span = tracing.spanNamed(send);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('AA21');
    expect(span.events[0]?.attributes).toEqual({ 'exception.type': 'TypeError' });
  });

  it('counts only the first call', () => {
    const tracker = createTxTracker();
    const handle = tracker.startUserOperationSend({ chainId: CHAIN_ID });
    handle.end({ userOpHash: USER_OP_HASH });
    handle.fail(new Error('late'));
    handle.end({ userOpHash: BUNDLE_HASH });
    const [span] = tracing.spans();
    expect(tracing.spans()).toHaveLength(1);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes['blockchain.user_operation.hash']).toBe(USER_OP_HASH);
  });
});

describe('user operation confirm span', () => {
  it('links to the send span and records the receipt, not the bundle transaction status or fee', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker.startUserOperationSend({ chainId: CHAIN_ID }).end({ userOpHash: USER_OP_HASH });
    });
    tool.end();
    // In the background: no active span, so the confirm span takes the send span's parent.
    context.with(ROOT_CONTEXT, () =>
      tracker
        .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
        .end(receipt),
    );

    const sent = tracing.spanNamed(send);
    const span = tracing.spanNamed(confirm);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.links.map((link) => link.context.spanId)).toEqual([sent.spanContext().spanId]);
    expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(span.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': USER_OP_HASH,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.used': 98_765,
      'blockchain.user_operation.gas.cost': '123456789000',
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.nonce': NONCE.toString(),
      'blockchain.user_operation.entry_point': ENTRY_POINT.toLowerCase(),
      'blockchain.tx.hash': BUNDLE_HASH,
      'blockchain.block.number': 42,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('takes an explicit parent first, then the active span, as for transactions', () => {
    const tracker = createTxTracker();
    tracker.startUserOperationSend({ chainId: CHAIN_ID }).end({ userOpHash: USER_OP_HASH });
    const explicit = trace.getTracer('test').startSpan('explicit');
    const waiting = trace.getTracer('test').startSpan('waiting');
    context.with(trace.setSpan(context.active(), waiting), () => {
      tracker
        .startUserOperationConfirm(
          { chainId: CHAIN_ID, userOpHash: USER_OP_HASH },
          trace.setSpan(ROOT_CONTEXT, explicit),
        )
        .end(receipt);
      tracker.startUserOperationConfirm({ chainId: 1, userOpHash: USER_OP_HASH }).end(receipt);
    });
    explicit.end();
    waiting.end();
    const [first, second] = tracing.spans().filter((s) => s.name.startsWith('confirm'));
    expect(first?.parentSpanContext?.spanId).toBe(explicit.spanContext().spanId);
    expect(second?.parentSpanContext?.spanId).toBe(waiting.spanContext().spanId);
  });

  it('records the nonce as a decimal string from a bigint, a hex string or a decimal string', () => {
    const tracker = createTxTracker();
    const nonces = [NONCE, `0x${NONCE.toString(16)}`, NONCE.toString(), 0n, '0x0'];
    nonces.forEach((nonce, i) => {
      tracker
        .startUserOperationConfirm({ chainId: i + 1, userOpHash: USER_OP_HASH })
        .end({ nonce });
    });
    expect(tracing.spans().map((s) => s.attributes['blockchain.user_operation.nonce'])).toEqual([
      NONCE.toString(),
      NONCE.toString(),
      NONCE.toString(),
      '0',
      '0',
    ]);
  });

  it('records the paymaster when one paid, and not the zero address', () => {
    const tracker = createTxTracker();
    const paymasters = [PAYMASTER, `0x${'0'.repeat(40)}`, undefined];
    paymasters.forEach((paymaster, i) => {
      tracker
        .startUserOperationConfirm({ chainId: i + 1, userOpHash: USER_OP_HASH })
        .end({ ...receipt, paymaster });
    });
    expect(tracing.spans().map((s) => s.attributes['blockchain.user_operation.paymaster'])).toEqual(
      [PAYMASTER, undefined, undefined],
    );
  });

  it('ends a reverted operation with error.type reverted and its revert reason', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end({ ...receipt, success: false, revertReason: `NotOwner(${SENDER})` });
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      'blockchain.user_operation.success': false,
      'error.type': 'reverted',
      'blockchain.tx.revert.reason': `NotOwner(${SENDER})`,
      // The bundle transaction itself succeeded; its status is not the operation's.
      'blockchain.tx.hash': BUNDLE_HASH,
    });
    expect(span.attributes['blockchain.tx.status']).toBeUndefined();
    expect(span.events).toEqual([]);
  });

  it('records a receipt without a success flag as an unknown outcome', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end({ transactionHash: BUNDLE_HASH, success: 'false' as unknown as boolean });
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['blockchain.user_operation.success']).toBeUndefined();
    expect(span.attributes['blockchain.tx.hash']).toBe(BUNDLE_HASH);
  });

  it('leaves out malformed receipt values', () => {
    const tracker = createTxTracker();
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end({
      actualGasCost: '-1',
      actualGasUsed: 2n ** 60n,
      sender: '0x12',
      nonce: '0xnope',
      paymaster: 'paymaster',
      entryPoint: 7 as unknown as string,
      revertReason: 42 as unknown as string,
      transactionHash: '0x1234',
      blockNumber: -1,
    });
    tracker.startUserOperationConfirm({ chainId: 1, userOpHash: USER_OP_HASH }).end({
      actualGasCost: 2n ** 256n,
      nonce: `0x${'f'.repeat(65)}`,
      actualGasUsed: '12.5',
    });
    tracker.startUserOperationConfirm({ chainId: 2, userOpHash: USER_OP_HASH }).end(null as never);
    expect(tracing.spans()).toHaveLength(3);
    for (const span of tracing.spans()) {
      expect(Object.keys(span.attributes).sort()).toEqual([
        'blockchain.chain.id',
        'blockchain.operation.name',
        'blockchain.system',
        'blockchain.system.name',
        'blockchain.user_operation.hash',
      ]);
    }
  });

  it('ends as timeout without a success flag (ADR 0016)', () => {
    const tracker = createTxTracker();
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).timeout();
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['blockchain.user_operation.success']).toBeUndefined();
  });

  it('ends as a failure with an error type and no exception event when there is no error', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .fail(undefined, { errorType: 'failed' });
    tracker
      .startUserOperationConfirm({ chainId: 1, userOpHash: USER_OP_HASH })
      .fail(new RangeError('boom'));
    const [failed, thrown] = tracing.spans();
    expect(failed?.attributes['error.type']).toBe('failed');
    expect(failed?.events).toEqual([]);
    expect(thrown?.attributes['error.type']).toBe('RangeError');
    expect(thrown?.events[0]?.attributes).toEqual({ 'exception.type': 'RangeError' });
  });

  it('records nothing for a wait without a valid user operation hash', () => {
    const tracker = createTxTracker();
    for (const userOpHash of ['0x12', undefined, 42]) {
      const handle = tracker.startUserOperationConfirm({
        chainId: CHAIN_ID,
        userOpHash: userOpHash as string,
      });
      handle.end(receipt);
      handle.timeout();
      handle.fail(new Error('x'));
    }
    expect(tracing.spans()).toEqual([]);
  });
});

describe('one confirm span per user operation (ADR 0007)', () => {
  it('joins concurrent waits; a timeout of one does not end the span while another waits', () => {
    const tracker = createTxTracker();
    const first = tracker.startUserOperationConfirm({
      chainId: CHAIN_ID,
      userOpHash: USER_OP_HASH,
    });
    const second = tracker.startUserOperationConfirm({
      chainId: CHAIN_ID,
      userOpHash: USER_OP_HASH.toUpperCase().replace('0X', '0x'),
    });
    first.timeout();
    expect(tracing.spans()).toEqual([]);
    second.end(receipt);
    first.end(receipt);
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spanNamed(confirm).status.code).toBe(SpanStatusCode.UNSET);

    // Settled: a later wait adds no span.
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);
    expect(tracing.spans()).toHaveLength(1);
  });

  it('ends with the last withdrawal, and a retry after a timeout gets a new span', () => {
    const tracker = createTxTracker();
    const first = tracker.startUserOperationConfirm({
      chainId: CHAIN_ID,
      userOpHash: USER_OP_HASH,
    });
    const second = tracker.startUserOperationConfirm({
      chainId: CHAIN_ID,
      userOpHash: USER_OP_HASH,
    });
    first.fail(new Error('network'));
    second.timeout();
    second.end(receipt);
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spans()[0]?.attributes['error.type']).toBe('timeout');

    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);
    expect(tracing.spans()).toHaveLength(2);
    expect(tracing.spans()[1]?.attributes['blockchain.user_operation.success']).toBe(true);
  });

  it('lets a wait after the link TTL get a new span, once the receipt has settled', async () => {
    const tracker = createTxTracker({ linkTtlMs: 1 });
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);
    expect(tracing.spans()).toHaveLength(2);
  });

  it('keeps user operations apart from transactions with the same hash', () => {
    const tracker = createTxTracker();
    tracker.startUserOperationSend({ chainId: CHAIN_ID }).end({ userOpHash: USER_OP_HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: USER_OP_HASH }).end({
      status: 'success',
      blockNumber: 1n,
      gasUsed: 21_000n,
    });
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);

    const [, transaction, operation] = tracing.spans();
    expect(transaction?.links).toEqual([]);
    expect(transaction?.attributes['blockchain.tx.status']).toBe('success');
    expect(operation?.links).toHaveLength(1);
    expect(operation?.attributes['blockchain.user_operation.success']).toBe(true);
  });

  it('links nothing from a transaction send to a user operation confirmation', () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: USER_OP_HASH });
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);
    expect(tracing.spanNamed(confirm).links).toEqual([]);
  });
});

describe('user operation privacy', () => {
  it('records addresses per the address mode', () => {
    for (const address of ['off' as const, { mode: 'hashed' as const, hash: () => 'h' }]) {
      tracing.exporter.reset();
      const tracker = createTxTracker({ address });
      tracker
        .startUserOperationSend({ chainId: CHAIN_ID, sender: SENDER, entryPoint: ENTRY_POINT })
        .end({ userOpHash: USER_OP_HASH });
      tracker
        .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
        .end({ ...receipt, paymaster: PAYMASTER });
      const exported = JSON.stringify(tracing.spans().map((s) => s.attributes)).toLowerCase();
      for (const value of [SENDER, ENTRY_POINT, PAYMASTER]) {
        expect(exported).not.toContain(value.toLowerCase());
      }
    }
  });

  it('keeps the user operation hash and success flag when the redaction hook fails', () => {
    const tracker = createTxTracker({
      redact: () => {
        throw new Error('broken');
      },
    });
    tracker
      .startUserOperationSend({ chainId: CHAIN_ID, sender: SENDER })
      .end({ userOpHash: USER_OP_HASH });
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end(receipt);
    expect(tracing.spanNamed(send).attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'send',
      'blockchain.user_operation.hash': USER_OP_HASH,
    });
    expect(tracing.spanNamed(confirm).attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': USER_OP_HASH,
      'blockchain.user_operation.success': true,
      'blockchain.tx.hash': BUNDLE_HASH,
    });
  });
});

describe('user operation metrics', () => {
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
  const base = {
    'blockchain.system': 'evm',
    'blockchain.system.name': 'evm',
    'blockchain.chain.id': CHAIN_ID,
    'blockchain.operation.subject': 'user_operation',
  };

  it('records send and confirmation durations and the operation cost, told apart from transactions', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    tracker
      .startUserOperationSend({ chainId: CHAIN_ID, startTime: new Date(1_000) })
      .end({ userOpHash: USER_OP_HASH }, { endTime: new Date(2_000) });
    tracker
      .startUserOperationSend({ chainId: CHAIN_ID, startTime: new Date(1_000) })
      .fail(new TypeError('x'), { endTime: new Date(1_500) });
    tracker
      .startUserOperationConfirm({
        chainId: CHAIN_ID,
        userOpHash: USER_OP_HASH,
        startTime: new Date(2_000),
      })
      .end({ ...receipt, success: false }, { endTime: new Date(6_000) });
    tracker
      .startUserOperationConfirm({
        chainId: CHAIN_ID,
        userOpHash: BUNDLE_HASH,
        startTime: new Date(2_000),
      })
      .timeout({ endTime: new Date(4_000) });

    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)).toEqual([
      { value: 1, attributes: base },
      { value: 0.5, attributes: { ...base, 'error.type': 'TypeError' } },
    ]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)).toEqual([
      { value: 4, attributes: { ...base, 'blockchain.user_operation.success': false } },
      { value: 2, attributes: { ...base, 'error.type': 'timeout' } },
    ]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([
      {
        value: 123_456_789_000,
        attributes: { ...base, 'blockchain.user_operation.success': false },
      },
    ]);
  });

  it('records no fee without the operation cost, and no success flag when it is unknown', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    tracker
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end({ transactionHash: BUNDLE_HASH });
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)[0]?.attributes).toEqual(
      base,
    );
  });
});

describe('user operation safety', () => {
  it('never throws, whatever it is called with', () => {
    const tracker = createTxTracker();
    expect(() => {
      tracker.startUserOperationSend(null as never).end({ userOpHash: USER_OP_HASH });
      tracker.startUserOperationSend(null as never).fail(new Error('x'));
      tracker.startUserOperationConfirm(null as never).end(receipt);
      const handle = tracker.startUserOperationSend({ chainId: CHAIN_ID });
      handle.end({ userOpHash: USER_OP_HASH }, 'not options' as never);
      const waiting = tracker.startUserOperationConfirm({
        chainId: CHAIN_ID,
        userOpHash: USER_OP_HASH,
      });
      waiting.end(receipt, { endTime: 'never' as never });
    }).not.toThrow();
  });

  it('returns a context that nests under the caller when starting the span fails', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('tool');
    const ctx = trace.setSpan(context.active(), tool);
    const handle = tracker.startUserOperationSend(null as never, ctx);
    expect(trace.getSpan(handle.context)).toBe(tool);
    tool.end();
  });
});
