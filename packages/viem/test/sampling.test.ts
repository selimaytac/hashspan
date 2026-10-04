// Sampling decisions of spans recorded after the call returned (issue #333). With a parent-based sampler, a span takes
// its parent's decision. A confirm span's parent is the span active when it starts, else the send's parent (the
// tool span), so a send and its confirm span are sampled together, also when the confirmation ends after the tool
// span. They split only when the confirm span gets another parent: `watch()` run inside another trace, a hash this
// tracker did not send, or a send it forgot (docs/troubleshooting.md).
import { context, propagation, type SpanContext, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createPublicClient, createWalletClient, type Hex } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, mockTransport, TO } from './mock-transport.js';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    // Half of the traces an agent starts are sampled; spans with a parent follow it.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.5) }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});
afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

const RUNS = 60;
const tracer = () => trace.getTracer('agent');

type Path = 'a foreground wait' | 'background confirmation' | 'watch() after the tool span ended';

/** One tool call that sends a transaction and confirms it on `path`; which of its spans were sampled. */
async function toolCall(path: Path): Promise<{ send: boolean; confirm: boolean }> {
  exporter.reset();
  const hashspan = withHashspan(
    path === 'background confirmation' ? { confirm: { mode: 'background' } } : {},
  );
  const wallet = createWalletClient({
    account: FROM,
    chain: base,
    transport: mockTransport().transport,
  }).extend(hashspan);
  const reader = createPublicClient({
    chain: base,
    transport: mockTransport().transport,
    pollingInterval: 10,
  }).extend(hashspan);
  let hash: Hex | undefined;
  await tracer().startActiveSpan('tool', async (span) => {
    hash = await wallet.sendTransaction({ to: TO });
    if (path === 'a foreground wait') await reader.waitForTransactionReceipt({ hash });
    span.end();
  });
  if (path === 'watch() after the tool span ended' && hash) hashspan.watch(reader, { hash });
  await hashspan.flush();
  const names = exporter.getFinishedSpans().map((s) => s.name);
  return { send: names.includes('send 8453'), confirm: names.includes('confirm 8453') };
}

describe('a parent-based ratio sampler', () => {
  it.each([
    'a foreground wait',
    'background confirmation',
    'watch() after the tool span ended',
  ] as const)('samples the send and the confirm span together, with %s', async (path) => {
    const outcomes = [];
    for (let run = 0; run < RUNS; run++) outcomes.push(await toolCall(path));

    expect(outcomes.filter(({ send, confirm }) => send !== confirm)).toEqual([]);
    // Both decisions occur, so the check is not vacuous (at a ratio of 0.5, each misses with p = 2^-60).
    expect(outcomes.some(({ send }) => send)).toBe(true);
    expect(outcomes.some(({ send }) => !send)).toBe(true);
  });
});

describe('a confirm span with another parent than the send', () => {
  /** Sends inside a tool span, and returns the hash and the tool span's context. */
  async function sendInTool(hashspan: ReturnType<typeof withHashspan>) {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(hashspan);
    return tracer().startActiveSpan('tool', async (span) => {
      const hash = await wallet.sendTransaction({ to: TO });
      span.end();
      return { hash, tool: span.spanContext() };
    });
  }
  const reader = () =>
    createPublicClient({ chain: base, transport: mockTransport().transport, pollingInterval: 10 });
  const parentOf = (name: string): SpanContext | undefined => {
    const span = exporter.getFinishedSpans().find((s) => s.name === name);
    if (!span) throw new Error(`no span named "${name}"`);
    return span.parentSpanContext;
  };

  // A sampled tool span and a sampled other span, so both spans are exported whatever the sampler decides.
  beforeEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
    // A new exporter: shutting the provider down stopped the previous one.
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  it('joins the trace of the span active when watch() runs, and is sampled with it', async () => {
    const hashspan = withHashspan();
    const { hash, tool } = await sendInTool(hashspan);
    const other = await tracer().startActiveSpan('other', async (span) => {
      hashspan.watch(reader(), { hash });
      span.end();
      return span.spanContext();
    });
    await hashspan.flush();

    expect(parentOf('confirm 8453')?.spanId).toBe(other.spanId);
    expect(parentOf('confirm 8453')?.traceId).not.toBe(tool.traceId);
  });

  it('starts a trace of its own for a send the tracker forgot (linkTtlMs)', async () => {
    const hashspan = withHashspan({ linkTtlMs: 1 });
    const { hash } = await sendInTool(hashspan);
    await new Promise((resolve) => setTimeout(resolve, 20));
    hashspan.watch(reader(), { hash });
    await hashspan.flush();

    expect(parentOf('confirm 8453')).toBeUndefined();
  });
});
