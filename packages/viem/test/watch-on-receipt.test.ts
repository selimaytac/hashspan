import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, type TransactionReceipt } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const readerWith = (options: Parameters<typeof mockTransport>[0] = {}) =>
  createPublicClient({
    chain: base,
    transport: mockTransport(options).transport,
    pollingInterval: 10,
  });

/** Watches `hash` and resolves with what `onReceipt` was called with, and how often. */
function watched(
  reader: ReturnType<typeof readerWith>,
  options: { chainId?: number; timeoutMs?: number } = {},
) {
  const hashspan = withHashspan();
  const calls: (TransactionReceipt | undefined)[] = [];
  let resolve: () => void = () => {};
  const called = new Promise<void>((r) => {
    resolve = r;
  });
  hashspan.watch(reader, {
    hash: HASH,
    ...options,
    onReceipt: (receipt) => {
      calls.push(receipt);
      resolve();
    },
  });
  return { hashspan, calls, called };
}

describe('watch() onReceipt', () => {
  it('is called once with the receipt, including its logs', async () => {
    const { hashspan, calls, called } = watched(readerWith());
    await called;
    await hashspan.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.transactionHash).toBe(HASH);
    expect(Array.isArray(calls[0]?.logs)).toBe(true);
    // The confirm span is recorded as without a callback.
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBe('success');
  });

  it('is called with undefined when no receipt comes before the timeout', async () => {
    const { calls, called } = watched(readerWith({ receipt: null }), { timeoutMs: 50 });
    await called;
    expect(calls).toEqual([undefined]);
  });

  it('is called with undefined when nothing is watched', async () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const { calls, called } = watched(readerWith(), { chainId: 1 });
    await called;
    expect(calls).toEqual([undefined]);
    expect(tracing.spans()).toEqual([]);
  });

  it('never breaks the confirmation when it throws', async () => {
    const error = vi.spyOn(diag, 'error').mockImplementation(() => {});
    const hashspan = withHashspan();
    hashspan.watch(readerWith(), {
      hash: HASH,
      onReceipt: () => {
        throw new Error('callback bug');
      },
    });
    await expect(hashspan.flush()).resolves.toBe(true);
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'hashspan: the onReceipt callback of watch() failed (Error)',
      ),
    );
  });
});
