import { createTxTracker } from '@hashspan/core';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPending } from '../src/pending.js';
import { createTransactionSpans } from '../src/transaction-spans.js';
import { createUserOperationSpans } from '../src/user-operation-spans.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Every confirm span a wait starts ends, whatever the wait settles with, and flush() reports it ended (ADR 0025,
// rule 1): an outcome that cannot be read ends the span as a failure instead of leaving it open.

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const CHAIN_ID = 8453;
const HASH = `0x${'ab'.repeat(32)}`;
const OP_HASH = `0x${'cd'.repeat(32)}`;

const trap = (): never => {
  throw new Error('trap');
};
/**
 * A value that throws on inspection: own property reads and `instanceof`. Its `get` trap answers, so that a promise
 * can resolve with it (resolving reads `then`).
 */
const unreadable = (): object =>
  new Proxy({}, { get: () => undefined, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
/** An error whose `name` is a getter that throws. */
const errorWithThrowingName = (): Error => {
  const error = new Error('boom');
  Object.defineProperty(error, 'name', { get: trap });
  return error;
};

function setup() {
  const tracker = createTxTracker();
  const pending = createPending();
  const shared = {
    tracker,
    readerFor: () => undefined,
    track: pending.track,
    waiting: pending.waiting,
    confirmTimeoutMs: undefined,
  };
  const transactions = createTransactionSpans({ ...shared, viem: {} as never });
  const userOperations = createUserOperationSpans(shared);
  return { pending, transactions, userOperations };
}

const confirms = () => tracing.spans().filter((span) => span.name === `confirm ${CHAIN_ID}`);

describe('a network-scoped waitForTransactionReceipt', () => {
  it('ends the confirm span for a receipt that throws on inspection', async () => {
    const { pending, transactions } = setup();
    const receipt = unreadable();

    await expect(
      transactions.confirmed(CHAIN_ID, { transactionHash: HASH }, async () => receipt),
    ).resolves.toBe(receipt);
    await expect(pending.flushOwn(1_000)).resolves.toBe(true);

    expect(pending.waiting.size).toBe(0);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirms()[0]?.attributes['error.type']).toBe('_OTHER');
  });

  it('ends the confirm span for a rejection that throws on inspection', async () => {
    const { pending, transactions } = setup();
    const rejection = unreadable();

    await expect(
      transactions.confirmed(CHAIN_ID, { transactionHash: HASH }, () => Promise.reject(rejection)),
    ).rejects.toBe(rejection);
    await expect(pending.flushOwn(1_000)).resolves.toBe(true);

    expect(pending.waiting.size).toBe(0);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['error.type']).toBe('_OTHER');
  });

  it('ends the confirm span for an error whose name getter throws', async () => {
    const { pending, transactions } = setup();
    const error = errorWithThrowingName();

    await expect(
      transactions.confirmed(CHAIN_ID, { transactionHash: HASH }, () => Promise.reject(error)),
    ).rejects.toBe(error);
    await expect(pending.flushOwn(1_000)).resolves.toBe(true);

    expect(pending.waiting.size).toBe(0);
    expect(confirms()).toHaveLength(1);
  });
});

describe('a waitForUserOperation', () => {
  const options = { userOpHash: OP_HASH };

  it('ends the confirm span for a result that throws on inspection', async () => {
    const { pending, userOperations } = setup();
    const result = unreadable();

    await expect(
      userOperations.confirmedUserOperation(
        CHAIN_ID,
        () => undefined,
        options,
        async () => result,
      ),
    ).resolves.toBe(result);
    await expect(pending.flushOwn(1_000)).resolves.toBe(true);

    expect(pending.waiting.size).toBe(0);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('ends the confirm span for a rejection that throws on inspection', async () => {
    const { pending, userOperations } = setup();
    const rejection = unreadable();

    await expect(
      userOperations.confirmedUserOperation(
        CHAIN_ID,
        () => undefined,
        options,
        () => Promise.reject(rejection),
      ),
    ).rejects.toBe(rejection);
    await expect(pending.flushOwn(1_000)).resolves.toBe(true);

    expect(pending.waiting.size).toBe(0);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['error.type']).toBe('_OTHER');
  });

  it('ends the confirm span for an error whose name getter throws', async () => {
    const { pending, userOperations } = setup();
    const error = errorWithThrowingName();

    await expect(
      userOperations.confirmedUserOperation(
        CHAIN_ID,
        () => undefined,
        options,
        () => Promise.reject(error),
      ),
    ).rejects.toBe(error);
    await expect(pending.flushOwn(1_000)).resolves.toBe(true);

    expect(pending.waiting.size).toBe(0);
    expect(confirms()).toHaveLength(1);
  });
});
