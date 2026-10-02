import type { TxTracker } from '@hashspan/core';
import { context, diag, trace } from '@opentelemetry/api';
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
    // Unhandled rejections are reported once the microtask queue has drained; callers flush pending work.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  expect(rejections).toEqual([]);
}

describe('clients without a chain', () => {
  it('never delay the call for the chain id', async () => {
    const { transport } = mockTransport({ chainId: () => new Promise<string>(() => {}) });
    const wallet = createWalletClient({ account: FROM, transport }).extend(withHashspan());
    const reader = createPublicClient({ transport, pollingInterval: 10 }).extend(withHashspan());

    await withoutUnhandledRejections(async () => {
      const started = Date.now();
      await expect(wallet.sendTransaction({ to: TO, chain: null })).resolves.toBe(HASH);
      await expect(reader.waitForTransactionReceipt({ hash: HASH })).resolves.toMatchObject({
        transactionHash: HASH,
      });
      expect(Date.now() - started).toBeLessThan(500);
    });
    expect(tracing.spans()).toHaveLength(0);
  });

  it('leave no grace timer behind when the chain id arrives before the call settles', async () => {
    const debug = vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { transport } = mockTransport({
      chainId: () => '0x2105',
      // The send settles after the chain id is known.
      sendDelayMs: 30,
    });
    const wallet = createWalletClient({ account: FROM, transport }).extend(withHashspan());
    const reader = createPublicClient({ transport, pollingInterval: 10 }).extend(withHashspan());

    await wallet.sendTransaction({ to: TO, chain: null });
    await reader.waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(2));

    const graceTimers = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 30_000);
    expect(graceTimers).toHaveLength(0);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('still unknown');
  });

  it('record the send span from call start to call end when the chain id arrives late', async () => {
    const { transport } = mockTransport({ chainId: () => later(150, '0x2105') });
    const wallet = createWalletClient({ account: FROM, transport }).extend(withHashspan());

    const started = Date.now();
    await wallet.sendTransaction({ to: TO, chain: null });
    const settled = Date.now();
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(1));

    const [send] = tracing.spans();
    // The chain id arrives 150 ms after the call settled: the span must use the call's times, not that moment.
    expect(toMs(send?.startTime)).toBeGreaterThanOrEqual(started - 1);
    expect(toMs(send?.startTime)).toBeLessThan(started + 75);
    expect(toMs(send?.endTime)).toBeGreaterThanOrEqual(settled - 75);
    expect(toMs(send?.endTime)).toBeLessThan(settled + 75);
    expect(send?.attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it('parent the send span on the active span and fall back to it for a later confirmation', async () => {
    const { transport } = mockTransport({ chainId: () => later(20, '0x2105') });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport }).extend(hashspan);
    const reader = createPublicClient({ transport, pollingInterval: 10 }).extend(hashspan);
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const hash = await context.with(trace.setSpan(context.active(), tool), () =>
      wallet.sendTransaction({ to: TO, chain: null }),
    );
    tool.end();
    await vi.waitFor(() => expect(tracing.spans().some((s) => s.name === 'send 8453')).toBe(true));
    await reader.waitForTransactionReceipt({ hash });
    await vi.waitFor(() =>
      expect(tracing.spans().some((s) => s.name === 'confirm 8453')).toBe(true),
    );

    const toolId = tool.spanContext().spanId;
    expect(tracing.spanNamed('send 8453').parentSpanContext?.spanId).toBe(toolId);
    expect(tracing.spanNamed('confirm 8453').parentSpanContext?.spanId).toBe(toolId);
    expect(tracing.spanNamed('confirm 8453').links[0]?.context.spanId).toBe(
      tracing.spanNamed('send 8453').spanContext().spanId,
    );
  });

  it('still attribute replaced transactions', async () => {
    const MINED = `0x${'cd'.repeat(32)}` as const;
    const mined = {
      transactionHash: MINED,
      status: 'success' as const,
      blockNumber: 124n,
      gasUsed: 21_000n,
      effectiveGasPrice: 2n,
    };
    const { transport } = mockTransport({ chainId: () => later(20, '0x2105') });
    const reader = createPublicClient({ transport })
      .extend(() => ({
        waitForTransactionReceipt: async (args: { onReplaced?: (r: unknown) => void }) => {
          args.onReplaced?.({
            reason: 'cancelled',
            replacedTransaction: { to: TO },
            transaction: { to: FROM },
            transactionReceipt: mined,
          });
          return mined;
        },
      }))
      .extend(withHashspan());

    await reader.waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(2));
    const original = tracing.spans().find((s) => s.attributes['blockchain.tx.hash'] === HASH);
    expect(original?.attributes['blockchain.tx.replacement.reason']).toBe('cancelled');
  });
});

describe('a custom tracker', () => {
  it('receives the start and end times of a late send', async () => {
    const ended: unknown[][] = [];
    const inputs: unknown[] = [];
    const tracker: TxTracker = {
      startSend: (input) => {
        inputs.push(input);
        return {
          context: context.active(),
          end: (...args) => void ended.push(args),
          fail: () => {},
        };
      },
      startConfirm: () => ({ end: () => {}, timeout: () => {}, fail: () => {} }),
      startPayment: () => ({ end: () => {}, fail: () => {}, timeout: () => {}, link: () => {} }),
    };
    const { transport } = mockTransport({ chainId: () => later(20, '0x2105') });
    const wallet = createWalletClient({ account: FROM, transport }).extend(
      withHashspan({ tracker }),
    );

    await wallet.sendTransaction({ to: TO, chain: null });
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]?.[0]).toBe(HASH);
    expect(ended[0]?.[1]).toBeInstanceOf(Date);
    expect((inputs[0] as { startTime?: unknown }).startTime).toBeInstanceOf(Date);
  });
});

describe('clients with a chain', () => {
  it('keep the monotonic clock', async () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(withHashspan());
    await wallet.sendTransaction({ to: TO });
    // Reads an SDK internal: with an explicit start time, the SDK ends spans by the wall clock.
    // Reads an SDK internal (sdk-trace-base Span): with a start time passed in, the SDK measures by the wall clock.
    const span = tracing.spanNamed('send 8453') as unknown as { _startTimeProvided?: boolean };
    expect(span._startTimeProvided).toBe(false);
  });
});
