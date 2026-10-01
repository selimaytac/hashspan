import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, createWalletClient } from 'viem';
import { mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await tracing.teardown();
});

const toMs = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);
const later = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** Fails the test on any unhandled rejection raised while `run` executes. */
async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  expect(rejections).toEqual([]);
}

describe('a chain id that cannot be resolved', () => {
  it('drops the span when eth_chainId rejects, and leaves the call unchanged', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { transport } = mockTransport({
      chainId: () => Promise.reject(new Error('provider down')),
    });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport }).extend(hashspan);

    await withoutUnhandledRejections(async () => {
      await expect(wallet.sendTransaction({ to: TO, chain: null })).resolves.toBe(HASH);
      await expect(hashspan.flush()).resolves.toBe(true);
    });
    expect(tracing.spans()).toHaveLength(0);
  });

  it('drops the span when eth_chainId returns a non-integer', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { transport } = mockTransport({ chainId: () => '0xnot-a-number' });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport }).extend(hashspan);

    await withoutUnhandledRejections(async () => {
      await expect(wallet.sendTransaction({ to: TO, chain: null })).resolves.toBe(HASH);
      await expect(hashspan.flush()).resolves.toBe(true);
    });
    expect(tracing.spans()).toHaveLength(0);
  });

  it('gives up 30 s after the call settled while the chain id is still pending', async () => {
    const debug = vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { transport } = mockTransport({ chainId: () => new Promise<string>(() => {}) });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport }).extend(hashspan);
    // Only the timers: the library reads them from globalThis when it needs them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await expect(wallet.sendTransaction({ to: TO, chain: null })).resolves.toBe(HASH);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('chain id still unknown'));
    await vi.advanceTimersByTimeAsync(1_001);

    expect(debug).toHaveBeenCalledWith(
      'hashspan: chain id still unknown after the call settled; not recording it',
    );
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spans()).toHaveLength(0);
  });
});

describe('calls that fail before the chain id is known', () => {
  it('records a failed send with the time the call settled', async () => {
    const { transport } = mockTransport({
      chainId: () => later(150, '0x1'),
      sendError: { code: -32000, message: 'insufficient funds' },
    });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport }).extend(hashspan);

    await expect(wallet.sendTransaction({ to: TO, chain: null })).rejects.toThrow();
    const settled = Date.now();
    await hashspan.flush();

    const send = tracing.spanNamed('send 1');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    // Ended when the call settled, not when the chain id arrived 150 ms later.
    expect(toMs(send.endTime)).toBeLessThan(settled + 75);
  });

  it('records a failed receipt wait with the time the call settled', async () => {
    const { transport } = mockTransport({
      chainId: () => later(150, '0x1'),
      failOn: ['eth_getTransactionReceipt'],
    });
    const hashspan = withHashspan();
    const reader = createPublicClient({ transport, pollingInterval: 10 }).extend(hashspan);

    await expect(reader.waitForTransactionReceipt({ hash: HASH })).rejects.toThrow();
    const settled = Date.now();
    await hashspan.flush();

    const confirm = tracing.spanNamed('confirm 1');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
    expect(toMs(confirm.endTime)).toBeLessThan(settled + 75);
  });

  it('records a timed-out receipt wait with the time the call settled', async () => {
    const { transport } = mockTransport({ chainId: () => later(150, '0x1'), receipt: null });
    const hashspan = withHashspan();
    const reader = createPublicClient({ transport, pollingInterval: 10 }).extend(hashspan);

    await expect(reader.waitForTransactionReceipt({ hash: HASH, timeout: 40 })).rejects.toThrow();
    const settled = Date.now();
    await hashspan.flush();

    const confirm = tracing.spanNamed('confirm 1');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirm.attributes['error.type']).toBe('timeout');
    expect(toMs(confirm.endTime)).toBeLessThan(settled + 75);
  });
});

describe('the recording safety net', () => {
  it('still ends the confirm span when the receipt cannot be read', async () => {
    const error = vi.spyOn(diag, 'error').mockImplementation(() => {});
    // mainnet has no OP-stack formatter, so the unparsable l1Fee reaches the adapter as it is.
    const { transport } = mockTransport({ chainIdHex: '0x1', receipt: { l1Fee: 'nope' } });
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: mainnet, transport }).extend(hashspan);

    await withoutUnhandledRejections(async () => {
      await expect(reader.waitForTransactionReceipt({ hash: HASH })).resolves.toMatchObject({
        transactionHash: HASH,
      });
      await expect(hashspan.flush()).resolves.toBe(true);
    });

    expect(tracing.spanNamed('confirm 1').status.code).toBe(SpanStatusCode.ERROR);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed to record receipt'));
  });
});
