import { OpenTelemetry } from '@ai-sdk/otel';
import { withHashspan } from '@hashspan/viem';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerTelemetry, stepCountIs, ToolLoopAgent, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { type Address, createWalletClient, type Hex, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { startAnvil } from '../../../packages/viem/test/start-anvil.js';

// Several agents in one service, running at once on one traced client, each step calling tools in parallel: every
// transaction must land under the tool call that sent it, with the identity of the agent that ran it (#332).

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

// Anvil's first four test accounts, one per tool call: transactions sent at once from one account would race for its
// nonce. Anvil signs for them.
const ACCOUNTS: Address[] = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
];

// No `agent` option: the identity comes from Baggage, so one client serves every agent.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const wallet = createWalletClient({
  chain: anvil,
  transport: http(rpcUrl),
  pollingInterval: 50,
}).extend(hashspan);

beforeAll(() => {
  provider.register();
  registerTelemetry(new OpenTelemetry());
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  await instance.stop();
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model whose first step calls `pay` twice in parallel, from the accounts `from`, then answers. */
function parallelModel(agent: string, amounts: [string, string], from: [number, number]) {
  return new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-model',
    doGenerate: [
      {
        content: amounts.map((wei, i) => ({
          type: 'tool-call' as const,
          toolCallId: `${agent}-call-${i}`,
          toolName: 'pay',
          input: JSON.stringify({ wei, from: from[i] }),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text' as const, text: 'Paid.' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      },
    ],
  });
}

const pay = tool({
  description: 'Pay an amount in wei.',
  inputSchema: z.object({ wei: z.string(), from: z.number() }),
  // Sends without waiting: the receipt comes through background confirmation, after the tool span ended.
  execute: async ({ wei, from }) => ({
    hash: await wallet.sendTransaction({
      account: ACCOUNTS[from] as Address,
      to: '0x00000000000000000000000000000000000000cc',
      value: BigInt(wei),
    }),
  }),
});

/** Runs one agent with its identity in Baggage; returns the transaction hash of each tool call id. */
async function runAgent(
  name: string,
  amounts: [string, string],
  from: [number, number],
): Promise<Map<string, Hex>> {
  const baggage = propagation.createBaggage({ 'gen_ai.agent.name': { value: name } });
  return context.with(propagation.setBaggage(context.active(), baggage), async () => {
    const agent = new ToolLoopAgent({
      id: name,
      telemetry: { functionId: name },
      model: parallelModel(name, amounts, from),
      tools: { pay },
      stopWhen: stepCountIs(3),
    });
    const result = await agent.generate({ prompt: 'Pay both invoices.' });
    return new Map(
      result.steps.flatMap((step) =>
        step.toolResults.map((r) => [r.toolCallId, (r.output as { hash: Hex }).hash] as const),
      ),
    );
  });
}

it('keeps each transaction under its own tool call and agent when agents and tool calls run in parallel', async () => {
  const runs = await Promise.all([
    runAgent('agent-a', ['1001', '1002'], [0, 1]),
    runAgent('agent-b', ['2001', '2002'], [2, 3]),
  ]);
  expect(await hashspan.flush()).toBe(true);

  const spans = exporter.getFinishedSpans();
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  const parentOf = (span: (typeof spans)[number]) =>
    span.parentSpanContext ? byId.get(span.parentSpanContext.spanId) : undefined;
  const rootOf = (span: (typeof spans)[number]) => {
    let current = span;
    for (let parent = parentOf(current); parent; parent = parentOf(current)) current = parent;
    return current;
  };
  /** The one span named `name` whose attribute `key` is `value`. */
  const only = (name: string, key: string, value: string) => {
    const found = spans.filter((s) => s.name === name && s.attributes[key] === value);
    expect(found, `${name} with ${key} ${value}`).toHaveLength(1);
    return found[0] as (typeof spans)[number];
  };
  expect(spans.filter((s) => s.name === 'send 31337')).toHaveLength(4);
  expect(spans.filter((s) => s.name === 'confirm 31337')).toHaveLength(4);

  for (const [index, hashes] of runs.entries()) {
    const agentName = index === 0 ? 'agent-a' : 'agent-b';
    expect(hashes.size).toBe(2);
    for (const [toolCallId, hash] of hashes) {
      const toolSpan = only('execute_tool pay', 'gen_ai.tool.call.id', toolCallId);
      const send = only('send 31337', 'blockchain.tx.hash', hash);
      const confirm = only('confirm 31337', 'blockchain.tx.hash', hash);

      // Both spans under the tool call that sent the transaction, in the trace of the agent that ran it.
      expect(parentOf(send)).toBe(toolSpan);
      expect(parentOf(confirm)).toBe(toolSpan);
      expect(rootOf(send).name).toBe('invoke_agent scripted-model');
      expect(rootOf(send).attributes['gen_ai.agent.name']).toBe(agentName);
      // The confirm span links to its own send span.
      expect(confirm.links.map((l) => l.context.spanId)).toEqual([send.spanContext().spanId]);
      // Both carry the identity of the agent that ran the tool call.
      expect(send.attributes['gen_ai.agent.name']).toBe(agentName);
      expect(confirm.attributes['gen_ai.agent.name']).toBe(agentName);
    }
  }
});
