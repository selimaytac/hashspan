// A pending receipt (#402), such as a Tempo multisig relay's answer to a sync send below quorum: no outcome. It
// withdraws the wait, as a timeout does, and as a pending call batch does: the confirm span ends without an outcome,
// error or metric sample only when no other wait is running, and a later wait gets its own span.
import {
  type Attributes,
  type Histogram,
  type MeterProvider,
  SpanStatusCode,
} from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTxTracker, type ReceiptLike } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 4217;
const HASH = `0x${'0e'.repeat(32)}`;
const PENDING = { status: 'pending', blockNumber: 0, gasUsed: 0 } as const satisfies ReceiptLike;
const MINED: ReceiptLike = {
  status: 'success',
  blockNumber: 123n,
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
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => ({
        record: (_value: number, attributes: Attributes = {}) => {
          samples.push({ name, attributes });
        },
      }),
    }),
  } as unknown as MeterProvider;
  const tracker = createTxTracker({ meterProvider: provider });
  const confirms = () => tracing.spans().filter((s) => s.name === `confirm ${CHAIN_ID}`);
  return { tracker, samples, confirms };
}

describe('a pending receipt', () => {
  it('ends the confirm span without an outcome, an error or a metric sample', () => {
    const { tracker, samples, confirms } = setup();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(PENDING);

    const [confirm, ...more] = confirms();
    expect(more).toEqual([]);
    expect(confirm?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm?.attributes).not.toHaveProperty('error.type');
    expect(confirm?.attributes).not.toHaveProperty('blockchain.tx.status');
    expect(confirm?.attributes).not.toHaveProperty('blockchain.block.number');
    expect(samples).toEqual([]);
  });

  it('withdraws only its own wait: another wait of the same transaction keeps the span and records its receipt', () => {
    const { tracker, confirms } = setup();
    const caller = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(PENDING);
    expect(confirms()).toEqual([]);
    caller.end(MINED);

    const [confirm, ...more] = confirms();
    expect(more).toEqual([]);
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('releases the transaction for a later wait, which gets a span of its own', () => {
    const { tracker, confirms } = setup();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(PENDING);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(MINED);

    expect(confirms().map((s) => s.attributes['blockchain.tx.status'])).toEqual([
      undefined,
      'success',
    ]);
  });
});
