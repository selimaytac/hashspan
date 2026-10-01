import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** The id of the span active when each request of `method` went out. */
function activeSpansOn(method: string) {
  const ids: (string | undefined)[] = [];
  const onRequest = (requested: string) => {
    if (requested === method) ids.push(trace.getActiveSpan()?.spanContext().spanId);
  };
  return { ids, onRequest };
}

/** Runs `fn` inside a tool span, as an agent framework would; returns the tool span. */
async function inTool(fn: () => Promise<unknown>) {
  const tool = trace.getTracer('test').startSpan('execute_tool transfer');
  await context.with(trace.setSpan(context.active(), tool), fn);
  tool.end();
  return tool;
}

describe('the sending call', () => {
  it('runs in the send span, so its requests nest under it', async () => {
    const sent = activeSpansOn('eth_sendTransaction');
    const { transport } = mockTransport({ onRequest: sent.onRequest });
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );
    await inTool(async () => {
      await wallet.sendTransaction({ to: TO });
      await wallet.writeContract({
        address: TO,
        abi: erc20,
        functionName: 'transfer',
        args: [FROM, 1n],
      });
    });

    const sendIds = tracing
      .spans()
      .filter((span) => span.name.startsWith('send '))
      .map((span) => span.spanContext().spanId);
    expect(sent.ids).toHaveLength(2);
    expect(sent.ids).toEqual(sendIds);
  });

  it('is the only part in the send span: confirmations stay under the caller', async () => {
    const { transport } = mockTransport();
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 1_000 } });
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(hashspan);
    const reader = createPublicClient({ chain: base, transport }).extend(hashspan);
    const tool = await inTool(async () => {
      const hash = await wallet.sendTransaction({ to: TO });
      await reader.waitForTransactionReceipt({ hash });
    });
    await hashspan.flush();

    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(tracing.spanNamed('send 8453').parentSpanContext?.spanId).toBe(
      tool.spanContext().spanId,
    );
  });

  it('fails the send span once when it throws synchronously, and rethrows', async () => {
    const boom = new TypeError('sync failure');
    const { transport } = mockTransport();
    const plain = createWalletClient({ account: FROM, chain: base, transport });
    const wallet = plain
      // An extension applied before hashspan whose action throws before returning a promise.
      .extend(() => ({
        sendTransaction: (() => {
          throw boom;
        }) as typeof plain.sendTransaction,
      }))
      .extend(withHashspan());
    await expect(wallet.sendTransaction({ to: TO })).rejects.toBe(boom);
    const [send] = tracing.spans();
    expect(tracing.spans()).toHaveLength(1);
    expect(send?.status.code).toBe(SpanStatusCode.ERROR);
    expect(send?.attributes['error.type']).toBe('TypeError');
  });

  it('runs in the caller context for a client without a chain, whose send span is recorded later', async () => {
    const sent = activeSpansOn('eth_sendTransaction');
    const { transport } = mockTransport({ onRequest: sent.onRequest });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport }).extend(hashspan);
    const tool = await inTool(() => wallet.sendTransaction({ to: TO, chain: null }));
    await hashspan.flush();

    expect(sent.ids).toEqual([tool.spanContext().spanId]);
    expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.hash']).toBe(HASH);
  });
});
