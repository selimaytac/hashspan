import {
  type Attributes,
  context,
  type Histogram,
  type MeterProvider,
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
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const BATCH_ID = '0xBatch-Id-1';
const TX_A = `0x${'a1'.repeat(32)}`;
const TX_B = `0x${'b2'.repeat(32)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const SENDER = '0x1111111111111111111111111111111111111111';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const send = `send ${CHAIN_ID}`;
const confirm = `confirm ${CHAIN_ID}`;
const confirms = () => tracing.spans().filter((s) => s.name === confirm);

describe('call batch send span', () => {
  it('is a CLIENT child of the active span with the sender, call count and batch id', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    let active: unknown;
    context.with(trace.setSpan(context.active(), tool), () => {
      const handle = tracker.startCallBatchSend({
        chainId: CHAIN_ID,
        sender: SENDER,
        callCount: 3,
      });
      active = trace.getSpan(handle.context);
      handle.end({ id: BATCH_ID });
    });
    tool.end();

    const span = tracing.spanNamed(send);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(active).toBeDefined();
    expect(span.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'send',
      'blockchain.call_batch.sender': SENDER,
      'blockchain.call_batch.call_count': 3,
      'blockchain.call_batch.id': BATCH_ID,
    });
  });

  it('records no batch id and no key for an id that is not a bounded string', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchSend({ chainId: CHAIN_ID }).end({ id: 42 as never });
    tracker.startCallBatchSend({ chainId: CHAIN_ID }).end({ id: 'x'.repeat(4097) });
    for (const span of tracing.spans()) {
      expect(span.attributes).not.toHaveProperty('blockchain.call_batch.id');
    }
  });

  it('truncates a long batch id in the attribute and keys the batch by the whole id', () => {
    const tracker = createTxTracker();
    const id = `0x${'ab'.repeat(200)}`;
    tracker.startCallBatchSend({ chainId: CHAIN_ID }).end({ id });
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id }).end({ statusCode: 200 });
    expect(tracing.spanNamed(send).attributes['blockchain.call_batch.id']).toBe(id.slice(0, 256));
    expect(tracing.spanNamed(confirm).links).toHaveLength(1);
  });

  it('ends with an error when the wallet rejected the batch', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchSend({ chainId: CHAIN_ID }).fail(new TypeError('rejected'));
    const span = tracing.spanNamed(send);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('TypeError');
  });
});

describe('call batch confirm span', () => {
  it('links to the send span and records the status code, atomicity, transaction hashes and last block', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchSend({ chainId: CHAIN_ID }).end({ id: BATCH_ID });
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID }).end({
      statusCode: 200,
      atomic: true,
      receipts: [
        { transactionHash: TX_A, blockNumber: 41n },
        { transactionHash: TX_B, blockNumber: 42 },
        { transactionHash: 'not a hash' },
      ],
    });

    const span = tracing.spanNamed(confirm);
    expect(span.links[0]?.context.spanId).toBe(tracing.spanNamed(send).spanContext().spanId);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toMatchObject({
      'blockchain.operation.name': 'confirm',
      'blockchain.call_batch.id': BATCH_ID,
      'blockchain.call_batch.status_code': 200,
      'blockchain.call_batch.atomic': true,
      'blockchain.call_batch.transaction_hashes': [TX_A, TX_B],
      'blockchain.block.number': 42,
    });
    // A wallet's receipt can be a bundle shared with others: no transaction status, gas or fee.
    for (const key of ['blockchain.tx.status', 'blockchain.tx.fee', 'blockchain.tx.gas.used']) {
      expect(span.attributes).not.toHaveProperty(key);
    }
  });

  it.each([
    [400, 'failed'],
    [422, 'failed'],
    [500, 'reverted'],
    [600, 'partially_reverted'],
  ])('ends a status %i with error.type %s', (statusCode, errorType) => {
    const tracker = createTxTracker();
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID }).end({ statusCode });
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe(errorType);
    expect(span.attributes['blockchain.call_batch.status_code']).toBe(statusCode);
  });

  it.each([
    ['without a code', {}],
    ['with a 3xx code', { statusCode: 300 }],
    ['with an unknown code', { statusCode: 999 }],
  ])('ends a status %s without an outcome', (_, status) => {
    const tracker = createTxTracker();
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID }).end(status);
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).not.toHaveProperty('error.type');
  });

  it('ends a pending status without an outcome', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID }).end({ statusCode: 100 });
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.attributes['blockchain.call_batch.status_code']).toBe(100);
  });

  it('shares one span between waits, ends as timeout only with the last one, and keeps ids case-sensitive', () => {
    const tracker = createTxTracker();
    const first = tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID });
    const second = tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID });
    const other = tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID.toLowerCase() });
    first.timeout();
    expect(confirms()).toHaveLength(0);
    second.timeout();
    other.end({ statusCode: 200 });
    expect(confirms()).toHaveLength(2);
    expect(confirms().map((s) => s.attributes['error.type'])).toContain('timeout');
  });

  it('ends with an error when the status could not be retrieved', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID }).fail(new TypeError('x'));
    const span = tracing.spanNamed(confirm);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('TypeError');
  });

  it('records nothing for a wait without a valid batch id', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: '' }).end({ statusCode: 200 });
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: 7 as never }).end({ statusCode: 200 });
    expect(confirms()).toHaveLength(0);
  });

  it('keeps batches apart from transactions with the same key', () => {
    const tracker = createTxTracker();
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: TX_A }).end({ statusCode: 200 });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: TX_A }).end({
      status: 'success',
      blockNumber: 1n,
      gasUsed: 21_000n,
    });
    expect(confirms()).toHaveLength(2);
  });
});

describe('transactions sent for a call batch', () => {
  it('link their confirm spans to the batch send span, except a zero hash', () => {
    const tracker = createTxTracker();
    tracker
      .startCallBatchSend({ chainId: CHAIN_ID })
      .end({ id: BATCH_ID, transactionHashes: [TX_A, ZERO_HASH] });
    const sendSpanId = tracing.spanNamed(send).spanContext().spanId;
    for (const hash of [TX_A, ZERO_HASH]) {
      tracker.startConfirm({ chainId: CHAIN_ID, hash }).end({
        status: 'success',
        blockNumber: 1n,
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
      });
    }
    const [linked, unlinked] = confirms();
    expect(linked?.links[0]?.context.spanId).toBe(sendSpanId);
    expect(linked?.attributes['blockchain.tx.fee']).toBe('21000');
    expect(unlinked?.links).toHaveLength(0);
  });
});

describe('call batch metrics', () => {
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
    'blockchain.chain.id': CHAIN_ID,
    'blockchain.operation.subject': 'call_batch',
  };

  it('records durations told apart from transactions, the outcome as error.type, and no fee', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    tracker
      .startCallBatchSend({ chainId: CHAIN_ID, startTime: new Date(1_000) })
      .end({ id: BATCH_ID }, { endTime: new Date(2_000) });
    tracker
      .startCallBatchConfirm({ chainId: CHAIN_ID, id: 'a', startTime: new Date(2_000) })
      .end({ statusCode: 200 }, { endTime: new Date(5_000) });
    tracker
      .startCallBatchConfirm({ chainId: CHAIN_ID, id: 'b', startTime: new Date(2_000) })
      .end({ statusCode: 600 }, { endTime: new Date(3_000) });
    tracker
      .startCallBatchConfirm({ chainId: CHAIN_ID, id: 'c', startTime: new Date(2_000) })
      .end({ statusCode: 100 }, { endTime: new Date(3_000) });
    tracker
      .startCallBatchConfirm({ chainId: CHAIN_ID, id: 'd', startTime: new Date(2_000) })
      .end({}, { endTime: new Date(3_000) });

    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION)).toEqual([
      { value: 1, attributes: base },
    ]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)).toEqual([
      { value: 3, attributes: base },
      { value: 1, attributes: { ...base, 'error.type': 'partially_reverted' } },
    ]);
    expect(meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)).toEqual([]);
  });
});

describe('call batch safety', () => {
  it('never throws, whatever it is called with', () => {
    const tracker = createTxTracker();
    expect(() => {
      tracker.startCallBatchSend(null as never).end({ id: BATCH_ID });
      tracker.startCallBatchSend({ chainId: CHAIN_ID }).end(null as never);
      tracker.startCallBatchConfirm(null as never).end({ statusCode: 200 });
      tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id: BATCH_ID }).end(null as never);
      tracker
        .startCallBatchConfirm({ chainId: CHAIN_ID, id: 'z' })
        .end({ receipts: [null, 5] as never, statusCode: '200' as never });
    }).not.toThrow();
  });
});
