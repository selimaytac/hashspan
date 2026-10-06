// `blockchain.tx.wait.confirmations` (#414): the confirmations of the wait that ended a transaction's shared confirm
// span (ADR 0007), span only, never a metric attribute.
import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_BLOCKCHAIN_TX_WAIT_CONFIRMATIONS,
  createTxTracker,
  type ReceiptLike,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';
import { countingGetters } from './hostile.js';

const CHAIN_ID = 8453;
const HASH = `0x${'1a'.repeat(32)}`;
const OTHER_HASH = `0x${'2b'.repeat(32)}`;
const RECEIPT: ReceiptLike = {
  status: 'success',
  blockNumber: 10n,
  gasUsed: 21_000n,
  effectiveGasPrice: 1n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

function setup() {
  const samples: { name: string; attributes: Attributes }[] = [];
  const meterProvider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => ({
        record: (_value: number, attributes: Attributes = {}) => {
          samples.push({ name, attributes });
        },
      }),
    }),
  } as unknown as MeterProvider;
  const tracker = createTxTracker({ meterProvider });
  const confirms = () => tracing.spans().filter((s) => s.name === `confirm ${CHAIN_ID}`);
  const recorded = () => confirms().map((s) => s.attributes[ATTR_BLOCKCHAIN_TX_WAIT_CONFIRMATIONS]);
  return { tracker, samples, confirms, recorded };
}

describe('blockchain.tx.wait.confirmations', () => {
  it('records the count of the wait whose receipt ended the span', () => {
    const { tracker, recorded } = setup();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 3 }).end(RECEIPT);
    expect(recorded()).toEqual([3]);
  });

  it('records 1 when a background wait of 1 ends the span before a caller wait of 3', () => {
    const { tracker, recorded } = setup();
    const background = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 1 });
    const caller = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 3 });
    background.end(RECEIPT);
    caller.end({ ...RECEIPT, blockNumber: 12n });
    expect(recorded()).toEqual([1]);
  });

  it.each([
    ['the wait of 2', 0, 2],
    ['the wait of 5', 1, 5],
  ])('records %s when its receipt ended the span of waits of 2 and 5', (_name, first, count) => {
    const { tracker, recorded } = setup();
    const handles = [2, 5].map((confirmations) =>
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations }),
    );
    handles[first]?.end(RECEIPT);
    handles[1 - first]?.end(RECEIPT);
    expect(recorded()).toEqual([count]);
  });

  it('records the count of the last wait to time out, which ends the span', () => {
    const { tracker, recorded } = setup();
    const short = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 2 });
    const long = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 7 });
    short.timeout();
    expect(recorded()).toEqual([]);
    long.timeout();
    expect(recorded()).toEqual([7]);
  });

  it('records the count of the last wait to fail, which ends the span', () => {
    const { tracker, recorded } = setup();
    const failing = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 4 });
    const timingOut = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 6 });
    timingOut.timeout();
    failing.fail(new Error('boom'));
    expect(recorded()).toEqual([4]);
  });

  it('records the count of the last wait to get a pending receipt', () => {
    const { tracker, recorded } = setup();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 2 })
      .end({ status: 'pending', blockNumber: 0, gasUsed: 0 });
    expect(recorded()).toEqual([2]);
  });

  it('records nothing for a wait that took no count, even after a wait with one withdrew', () => {
    const { tracker, recorded } = setup();
    const counted = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 3 });
    const uncounted = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    counted.timeout();
    uncounted.end(RECEIPT);
    expect(recorded()).toEqual([undefined]);
  });

  it('records the count on the replaced span and on the replacing one its receipt ended', () => {
    const { tracker, confirms } = setup();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 3 })
      .end({ ...RECEIPT, transactionHash: OTHER_HASH, replacementReason: 'repriced' });
    const byHash = Object.fromEntries(
      confirms().map((s) => [
        s.attributes['blockchain.tx.hash'],
        s.attributes[ATTR_BLOCKCHAIN_TX_WAIT_CONFIRMATIONS],
      ]),
    );
    expect(byHash).toEqual({ [HASH]: 3, [OTHER_HASH]: 3 });
  });

  it('records the count of a receipt that cannot be attributed', () => {
    const { tracker, recorded } = setup();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 3 })
      .end({ ...RECEIPT, blockNumber: 'x' as never });
    expect(recorded()).toEqual([3]);
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['NaN', Number.NaN],
    ['1.5', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2**53', 2 ** 53],
    ['3n', 3n],
    ['"3"', '3'],
    ['null', null],
  ])('records nothing for %s', (_name, confirmations) => {
    const { tracker, recorded } = setup();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: confirmations as never })
      .end(RECEIPT);
    expect(recorded()).toEqual([undefined]);
  });

  it('runs no getter and records nothing for a count behind an accessor', () => {
    const { tracker, recorded } = setup();
    const input = countingGetters({ confirmations: 3 });
    Object.assign(input.value, { chainId: CHAIN_ID, hash: HASH });
    tracker.startConfirm(input.value as never).end(RECEIPT);
    expect(input.reads()).toBe(0);
    expect(recorded()).toEqual([undefined]);
  });

  it('never puts the count on a metric sample', () => {
    const { tracker, samples } = setup();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 3 }).end(RECEIPT);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: OTHER_HASH, confirmations: 3 }).timeout();
    expect(samples.length).toBeGreaterThan(0);
    for (const { attributes } of samples) {
      expect(attributes).not.toHaveProperty(ATTR_BLOCKCHAIN_TX_WAIT_CONFIRMATIONS);
    }
  });

  it('is not recorded by a wait that joins after the span ended', () => {
    const { tracker, recorded } = setup();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 2 }).end(RECEIPT);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, confirmations: 9 }).end(RECEIPT);
    expect(recorded()).toEqual([2]);
  });
});
