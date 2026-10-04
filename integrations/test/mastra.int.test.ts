// The Mastra setup of docs/integrations.md, run against Anvil: an agent with a scripted model calls a tool that sends a
// transaction and waits for its receipt, with and without Mastra's OpenTelemetry bridge. Nothing leaves localhost
// (see offline.ts, a setup file).
import { withHashspan } from '@hashspan/viem';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';
import { OtelBridge } from '@mastra/otel-bridge';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { MockLanguageModelV4 } from 'ai/test';
import { createWalletClient, type Hex, http, parseEther, publicActions } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { offline } from './offline.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc';
// Anvil's first account, unlocked on the node.
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOOL = 'pay_vendor';

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: foundry.id,
});
const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
// The OpenTelemetry Node SDK registers the tracer provider and the context manager the bridge needs. Without
// metric readers and log processors of its own, it would start OTLP exporters for both.
const sdk = new NodeSDK({
  spanProcessors: [processor],
  metricReaders: [],
  logRecordProcessors: [],
});

beforeAll(async () => {
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  await instance.stop();
});

beforeEach(() => exporter.reset());

const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** A model that calls the tool once, then answers, so the agent runs without an API key. */
const scriptedModel = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-model',
    doGenerate: [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: TOOL,
            input: JSON.stringify({ amountEth: '0.01' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'Paid the vendor 0.01 ETH.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    ],
  });

/** Runs the agent once and returns the hash of the transaction its tool sent. */
async function runAgent(observability: 'bridge' | 'none'): Promise<Hex> {
  const hashspan = withHashspan();
  const wallet = createWalletClient({ account: ACCOUNT, chain: foundry, transport: http(RPC_URL) })
    .extend(publicActions)
    .extend(hashspan);
  // Mastra turns an error of the tool into the tool's result, so the test keeps what the tool did.
  let sent: Hex | undefined;
  const payVendor = createTool({
    id: TOOL,
    description: 'Pays the vendor an amount of ETH.',
    inputSchema: z.object({ amountEth: z.string() }),
    execute: async ({ amountEth }) => {
      const hash = await wallet.sendTransaction({ to: RECIPIENT, value: parseEther(amountEth) });
      const receipt = await wallet.waitForTransactionReceipt({ hash });
      sent = hash;
      return { hash, status: receipt.status };
    },
  });
  const agent = new Agent({
    id: 'treasury',
    name: 'treasury',
    instructions: 'Pay vendors when asked.',
    model: scriptedModel(),
    tools: { [TOOL]: payVendor },
  });
  const mastra = new Mastra({
    agents: { treasury: agent },
    ...(observability === 'bridge'
      ? {
          observability: new Observability({
            configs: { default: { serviceName: 'treasury-agent', bridge: new OtelBridge() } },
          }),
        }
      : {}),
  });

  const result = await mastra.getAgent('treasury').generate('Pay the vendor 0.01 ETH.');
  expect(result.text).toBe('Paid the vendor 0.01 ETH.');
  await hashspan.flush();
  // The SDK's resource detectors finish asynchronously, and the processor exports ended spans only after them.
  await processor.forceFlush();
  expect(sent).toMatch(/^0x[0-9a-f]{64}$/);
  expect(offline.unexpected).toEqual([]);
  return sent as Hex;
}

const spanNamed = (name: string): tracing.ReadableSpan => {
  const spans = exporter.getFinishedSpans();
  const span = spans.find((s) => s.name === name);
  if (!span) throw new Error(`no span named "${name}" in [${spans.map((s) => s.name)}]`);
  return span;
};
const parentOf = (span: tracing.ReadableSpan): tracing.ReadableSpan | undefined =>
  exporter
    .getFinishedSpans()
    .find((s) => s.spanContext().spanId === span.parentSpanContext?.spanId);

/** Asserts the transaction's send and confirm spans and returns them. */
function transactionSpans(hash: Hex): tracing.ReadableSpan[] {
  const send = spanNamed(`send ${foundry.id}`);
  const confirm = spanNamed(`confirm ${foundry.id}`);
  expect(send.attributes['blockchain.tx.hash']).toBe(hash);
  expect(confirm.attributes['blockchain.tx.hash']).toBe(hash);
  expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  return [send, confirm];
}

describe('Mastra', () => {
  it('without observability: the send and confirm spans start traces of their own', async () => {
    const hash = await runAgent('none');
    // Mastra records no span of its own.
    expect(
      exporter
        .getFinishedSpans()
        .map((s) => s.name)
        .sort(),
    ).toEqual([`confirm ${foundry.id}`, `send ${foundry.id}`]);
    for (const span of transactionSpans(hash)) expect(span.parentSpanContext).toBeUndefined();
  });

  it('with the OpenTelemetry bridge: the tool span is the parent of the send and confirm spans', async () => {
    const hash = await runAgent('bridge');
    const tool = spanNamed(`execute_tool ${TOOL}`);
    for (const span of transactionSpans(hash)) {
      expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
      expect(span.spanContext().traceId).toBe(tool.spanContext().traceId);
    }
    // The tool span is a descendant of the agent's span, which is the root of the trace; Mastra's spans for the
    // model call and the agent's step lie between them.
    let ancestor = parentOf(tool);
    while (ancestor && !ancestor.name.startsWith('invoke_agent')) ancestor = parentOf(ancestor);
    expect(ancestor?.name).toBe('invoke_agent treasury');
    expect(ancestor?.spanContext().traceId).toBe(tool.spanContext().traceId);
    expect(ancestor?.parentSpanContext).toBeUndefined();
  });
});
