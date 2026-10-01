import { createPublicClient, createWalletClient, encodeErrorResult, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const boom = encodeErrorResult({
  abi: parseAbi(['error Error(string)']),
  errorName: 'Error',
  args: ['boom'],
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

describe('flush', () => {
  it('resolves true at once when nothing is pending', async () => {
    await expect(withHashspan().flush()).resolves.toBe(true);
  });

  it('waits for the revert reason of a reverted transaction', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({
        receipt: { status: '0x0' },
        callRevertData: boom,
        callDelayMs: 100,
      }).transport,
    }).extend(hashspan);

    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spans()).toHaveLength(0);

    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.revert.reason']).toBe(
      'boom',
    );
  });

  it('waits for background confirmations', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(hashspan);

    await wallet.sendTransaction({ to: TO });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBe('success');
  });

  it('resolves false when pending work outlasts the timeout, and never rejects', async () => {
    const hashspan = withHashspan({ decodeRevertReason: { timeoutMs: 5_000 } });
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({
        receipt: { status: '0x0' },
        callRevertData: boom,
        callDelayMs: 1_000,
      }).transport,
    }).extend(hashspan);

    await reader.waitForTransactionReceipt({ hash: HASH });
    const started = Date.now();
    await expect(hashspan.flush({ timeoutMs: 50 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('exports a pending background confirmation as timeout when the flush times out', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 500 } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    }).extend(hashspan);

    await wallet.sendTransaction({ to: TO });
    await expect(hashspan.flush({ timeoutMs: 50 })).resolves.toBe(false);
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBeUndefined();
    expect(tracing.spanNamed('confirm 8453').attributes['error.type']).toBe('timeout');
    // The abandoned work no longer counts as pending.
    await expect(hashspan.flush({ timeoutMs: 50 })).resolves.toBe(true);
  });
});
