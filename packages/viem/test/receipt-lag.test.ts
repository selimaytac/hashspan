import { SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const confirms = () => tracing.spans().filter((s) => s.name === 'confirm 8453');

/** A node that returns the mined transaction, and blocks containing it, before it returns the receipt. */
function laggingNode(receiptAfterCalls: number) {
  let receiptCalls = 0;
  const mock = mockTransport({
    advanceBlocks: true,
    blockIncludesTransaction: true,
    mined: () => ++receiptCalls > receiptAfterCalls,
  });
  return { ...mock, receiptCalls: () => receiptCalls };
}

describe('a node that returns the receipt late', () => {
  it("makes viem's own wait fail, which the traced wait passes on unchanged", async () => {
    const node = laggingNode(3);
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    }).extend(withHashspan());
    await expect(reader.waitForTransactionReceipt({ hash: HASH, retryDelay: 1 })).rejects.toThrow(
      expect.objectContaining({ name: 'TransactionReceiptNotFoundError' }),
    );
  });

  it('is waited for again by watch(), until the receipt arrives', async () => {
    const node = laggingNode(3);
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });
    hashspan.watch(reader, { hash: HASH });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBe('success');
    expect(node.receiptCalls()).toBeGreaterThan(3);
  });

  it('is waited for again by background confirmation after a send', async () => {
    const node = laggingNode(3);
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await wallet.sendTransaction({ to: TO, value: 1n });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('records a plain success when viem reports the transaction as its own replacement', async () => {
    // The receipt appears on the request viem makes for the "replacement" it found: the transaction itself.
    const node = laggingNode(2);
    const onReplaced = vi.fn();
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await reader.waitForTransactionReceipt({ hash: HASH, retryDelay: 1, onReplaced });
    expect(onReplaced).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'repriced',
        transaction: expect.objectContaining({ hash: HASH }),
      }),
    );

    const [confirm] = confirms();
    expect(confirms()).toHaveLength(1);
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
    expect(confirm?.attributes['blockchain.tx.replacement.hash']).toBeUndefined();
    expect(confirm?.attributes['blockchain.tx.replacement.reason']).toBeUndefined();
  });

  it('ends as a timeout when the receipt does not arrive in time', async () => {
    const node = laggingNode(Number.POSITIVE_INFINITY);
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });
    hashspan.watch(reader, { hash: HASH, timeoutMs: 300 });
    await expect(hashspan.flush()).resolves.toBe(true);

    const [confirm] = confirms();
    expect(confirm?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirm?.attributes['error.type']).toBe('timeout');
    expect(confirm?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
