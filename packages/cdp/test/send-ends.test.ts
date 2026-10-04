import { createTxTracker } from '@hashspan/core';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPending } from '../src/pending.js';
import { createTransactionSpans } from '../src/transaction-spans.js';
import { createUserOperationSpans } from '../src/user-operation-spans.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Every send span a call starts ends, whatever the call rejects with (ADR 0025, rule 1): a rejection that cannot be
// read ends the span as a failure with `error.type` `_OTHER` instead of leaving it open, and reaches the caller as is.

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const CHAIN_ID = 8453;

const trap = (): never => {
  throw new Error('trap');
};
/** A rejection that throws on any inspection, `instanceof` included. */
const unreadable = (): object =>
  new Proxy(
    {},
    { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, has: trap, ownKeys: trap },
  );

function setup() {
  const pending = createPending();
  const shared = {
    tracker: createTxTracker(),
    readerFor: () => undefined,
    track: pending.track,
    waiting: pending.waiting,
    confirmTimeoutMs: undefined,
  };
  return {
    transactions: createTransactionSpans({ ...shared, viem: {} as never }),
    userOperations: createUserOperationSpans(shared),
  };
}

const sends = () => tracing.spans().filter((span) => span.name.startsWith('send '));

describe('a send that rejects with a value that cannot be read', () => {
  it('ends the transaction send span as _OTHER', async () => {
    const { transactions } = setup();
    const rejection = unreadable();

    await expect(
      transactions.traced(
        () => CHAIN_ID,
        () => ({}),
        () => Promise.reject(rejection),
      ),
    ).rejects.toBe(rejection);

    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(sends()[0]?.attributes['error.type']).toBe('_OTHER');
  });

  it('ends the user operation send span as _OTHER', async () => {
    const { userOperations } = setup();
    const rejection = unreadable();

    await expect(
      userOperations.tracedUserOperation(
        () => CHAIN_ID,
        () => ({}),
        () => Promise.reject(rejection),
      ),
    ).rejects.toBe(rejection);

    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(sends()[0]?.attributes['error.type']).toBe('_OTHER');
  });
});

describe('a send that rejects with a CDP API error', () => {
  it('still records its error type', async () => {
    const { transactions } = setup();
    const rejection = Object.assign(new Error('no funds'), { errorType: 'insufficient_balance' });

    await expect(
      transactions.traced(
        () => CHAIN_ID,
        () => ({}),
        () => Promise.reject(rejection),
      ),
    ).rejects.toBe(rejection);

    expect(sends()[0]?.attributes['error.type']).toBe('insufficient_balance');
  });
});
