import { diag, type HrTime, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker, type EndOptions } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'ab'.repeat(32)}`;
const RECEIPT = { status: 'success' as const, blockNumber: 1n, gasUsed: 21_000n };
const START = new Date('2026-01-01T00:00:00.000Z');
const END = new Date('2026-01-01T00:00:05.000Z');
const END_HR: HrTime = [Math.floor(END.getTime() / 1000), 0];

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const endTimes = (): HrTime[] => tracing.spans().map((span) => span.endTime);
const late = { chainId: CHAIN_ID, startTime: START };

describe('handle methods with an options object', () => {
  it('end every kind of span at the given end time', () => {
    const tracker = createTxTracker();
    tracker.startSend(late).end({ hash: HASH }, { endTime: END });
    tracker.startSend(late).fail(new Error('x'), { endTime: END });
    tracker.startConfirm({ ...late, hash: HASH }).end(RECEIPT, { endTime: END });
    tracker.startConfirm({ ...late, hash: `0x${'cd'.repeat(32)}` }).timeout({ endTime: END });
    tracker.startConfirm({ ...late, hash: `0x${'ef'.repeat(32)}` }).fail(new Error('x'), {
      endTime: END,
    });
    tracker
      .startPayment({ ...late, protocol: 'x402' })
      .end({ status: 'settled' }, { endTime: END });
    tracker.startPayment({ ...late, protocol: 'x402' }).fail(new Error('x'), { endTime: END });
    expect(endTimes()).toEqual(Array(7).fill(END_HR));
  });

  it('records the transaction hash of a send result', () => {
    createTxTracker().startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
    expect(tracing.spans()[0]?.attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it("records an adapter's error type", () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).fail(new TypeError('x'), { errorType: 'rejected' });
    tracker
      .startPayment({ chainId: CHAIN_ID, protocol: 'x402' })
      .fail(new TypeError('x'), { errorType: 'spend_limit', endTime: END });
    expect(tracing.spans().map((s) => s.attributes['error.type'])).toEqual([
      'rejected',
      'spend_limit',
    ]);
  });

  it('end a send span without a hash when the result has none', () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    createTxTracker()
      .startSend({ chainId: CHAIN_ID })
      .end({} as { hash: string });
    const [span] = tracing.spans();
    expect(span?.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe('deprecated positional end times', () => {
  it.each([
    ['a Date', END],
    ['an HrTime', END_HR],
    ['milliseconds', END.getTime()],
  ])('accept %s', (_, endTime) => {
    const tracker = createTxTracker();
    tracker.startSend(late).end(HASH, endTime);
    tracker.startSend(late).fail(new Error('x'), endTime);
    tracker.startConfirm({ ...late, hash: HASH }).end(RECEIPT, endTime);
    tracker.startConfirm({ ...late, hash: `0x${'cd'.repeat(32)}` }).timeout(endTime);
    tracker.startConfirm({ ...late, hash: `0x${'ef'.repeat(32)}` }).fail(new Error('x'), endTime);
    expect(endTimes()).toEqual(Array(5).fill(END_HR));
    expect(tracing.spans()[0]?.attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it('keep the error type after a positional end time, given or not', () => {
    const tracker = createTxTracker();
    tracker.startSend(late).fail(new TypeError('x'), END, { errorType: 'first' });
    tracker.startSend({ chainId: CHAIN_ID }).fail(new TypeError('x'), undefined, {
      errorType: 'second',
    });
    expect(tracing.spans().map((s) => s.attributes['error.type'])).toEqual(['first', 'second']);
    expect(endTimes()[0]).toEqual(END_HR);
  });

  it('win over the end time in the options', () => {
    createTxTracker()
      .startSend(late)
      .fail(new Error('x'), END, { endTime: new Date(), errorType: 'rejected' } as EndOptions);
    expect(endTimes()).toEqual([END_HR]);
  });
});

describe('handle arguments of neither form', () => {
  it.each([
    ['a string', 'soon'],
    ['null', null],
    ['NaN', Number.NaN],
    ['a three-number array', [1, 2, 3]],
    ['an end time that is not one', { endTime: 'soon' }],
  ])('are ignored: %s', (_, argument) => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const tracker = createTxTracker();
    const before = Date.now();
    const bad = argument as unknown as EndOptions;
    expect(() => {
      tracker.startSend(late).end({ hash: HASH }, bad);
      tracker.startSend(late).fail(new Error('x'), bad);
      tracker.startConfirm({ ...late, hash: HASH }).end(RECEIPT, bad);
      tracker.startConfirm({ ...late, hash: `0x${'cd'.repeat(32)}` }).timeout(bad);
      tracker.startPayment({ ...late, protocol: 'x402' }).end({ status: 'settled' }, bad);
    }).not.toThrow();
    // Ended now, not at a time read from the argument.
    for (const [seconds] of endTimes())
      expect(seconds).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(tracing.spans()).toHaveLength(5);
  });

  it('do not hand an invalid end time to the SDK', () => {
    const debug = vi.spyOn(diag, 'debug').mockImplementation(() => {});
    createTxTracker()
      .startSend(late)
      .end({ hash: HASH }, { endTime: 'soon' } as unknown as EndOptions);
    expect(debug).toHaveBeenCalledWith('hashspan: ignoring an end time that is not a TimeInput');
  });

  it('never run into a throwing getter', () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const throwing = {
      get endTime(): never {
        throw new Error('getter');
      },
    };
    const tracker = createTxTracker();
    expect(() => tracker.startSend(late).end({ hash: HASH }, throwing)).not.toThrow();
    expect(() => tracker.startSend(late).fail(new Error('x'), throwing)).not.toThrow();
    expect(tracing.spans()).toHaveLength(2);
  });
});
