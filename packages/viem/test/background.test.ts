import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, publicActions } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const confirmSpans = () => tracing.spans().filter((s) => s.name === 'confirm 8453');

describe('background confirmation', () => {
  it('confirms sent transactions without an explicit wait', async () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(withHashspan({ confirm: { mode: 'background' } }));
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    await context.with(trace.setSpan(context.active(), tool), () =>
      wallet.sendTransaction({ to: TO }),
    );
    tool.end();

    await vi.waitFor(() => expect(confirmSpans()).toHaveLength(1));
    const [confirm] = confirmSpans();
    expect(confirm?.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(confirm?.links[0]?.context.spanId).toBe(
      tracing.spanNamed('send 8453').spanContext().spanId,
    );
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('does not delay the send and ends with a timeout when no receipt arrives', async () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    }).extend(withHashspan({ confirm: { mode: 'background', timeoutMs: 100 } }));

    await wallet.sendTransaction({ to: TO });
    expect(confirmSpans()).toHaveLength(0);

    await vi.waitFor(() => expect(confirmSpans()).toHaveLength(1));
    const [confirm] = confirmSpans();
    expect(confirm?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm?.attributes['blockchain.tx.status']).toBe('timeout');
  });

  it('emits a single confirm span when the caller also waits for the receipt', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: TO });
    const receipt = await reader.waitForTransactionReceipt({ hash });

    expect(receipt.transactionHash).toBe(hash);
    await vi.waitFor(() => expect(confirmSpans()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(confirmSpans()).toHaveLength(1);
  });

  it('does not add a second confirm span when the caller waits after the background confirmation ended', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: TO });
    await vi.waitFor(() => expect(confirmSpans()).toHaveLength(1));
    await reader.waitForTransactionReceipt({ hash });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(confirmSpans()).toHaveLength(1);
  });

  it('traces a retry after a timed-out wait as a new confirm span', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    }).extend(withHashspan());
    const hash = `0x${'ef'.repeat(32)}` as const;
    await reader.waitForTransactionReceipt({ hash, timeout: 30 }).catch(() => {});
    await reader.waitForTransactionReceipt({ hash, timeout: 30 }).catch(() => {});
    await vi.waitFor(() => expect(confirmSpans()).toHaveLength(2));
  });

  it('is off by default', async () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(withHashspan());
    await wallet.sendTransaction({ to: TO });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(confirmSpans()).toHaveLength(0);
  });
});

describe("background confirmation and the caller's own wait on the same client", () => {
  const sameClient = (options: { timeoutMs: number }, mined: () => boolean) =>
    createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport({ mined, advanceBlocks: true }).transport,
      pollingInterval: 10,
    })
      .extend(publicActions)
      .extend(withHashspan({ confirm: { mode: 'background', ...options } }));

  it('still resolves the caller wait after the background confirmation timed out', async () => {
    let mined = false;
    const wallet = sameClient({ timeoutMs: 30 }, () => mined);
    const hash = await wallet.sendTransaction({ to: TO });
    const wait = wallet.waitForTransactionReceipt({ hash, timeout: 1_000 });
    setTimeout(() => {
      mined = true;
    }, 80);
    await expect(wait).resolves.toMatchObject({ transactionHash: hash });
  });

  it("applies the caller's own confirmations", async () => {
    const wallet = sameClient({ timeoutMs: 1_000 }, () => true);
    const hash = await wallet.sendTransaction({ to: TO });
    const receipt = await wallet.waitForTransactionReceipt({ hash, confirmations: 3 });
    // The receipt is in block 0x7b; three confirmations need block 0x7d.
    expect(receipt.transactionHash).toBe(hash);
    expect(await wallet.getBlockNumber({ cacheTime: 0 })).toBeGreaterThanOrEqual(0x7dn);
  });
});
