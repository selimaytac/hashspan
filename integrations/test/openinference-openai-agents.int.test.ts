// The OpenAI Agents SDK setup of docs/integrations.md ("Agent frameworks"): an agent instrumented by OpenInference,
// with a scripted model and a tool that sends a transaction on Anvil. Nothing leaves localhost (see offline.ts, a
// setup file).
import { OpenAIAgentsInstrumentation } from '@arizeai/openinference-instrumentation-openai-agents';
import * as agents from '@openai/agents';
import type { Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freePort } from '../../packages/viem/test/free-port.js';
import { offline } from './offline.js';
import {
  inAgentSpan,
  OPENINFERENCE_KIND,
  payVendor,
  spansOf,
  startAnvil,
  TOOL_SPAN,
  tracedWallet,
} from './openinference.js';

const PORT = await freePort();

/** A model that calls the `pay_vendor` tool on its first turn and answers on its second; it never sends a request. */
class ScriptedModel implements agents.Model {
  #turn = 0;

  async getResponse(): Promise<agents.ModelResponse> {
    const output: agents.ModelResponse['output'] =
      this.#turn++ === 0
        ? [
            {
              type: 'function_call',
              callId: 'call_1',
              name: TOOL_SPAN,
              arguments: '{}',
              status: 'completed',
            },
          ]
        : [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Paid the vendor.' }],
            },
          ];
    return { usage: new agents.Usage(), output };
  }

  getStreamedResponse(): AsyncIterable<agents.StreamEvent> {
    throw new Error('not used by these tests');
  }
}

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let instrumentation: OpenAIAgentsInstrumentation;

beforeAll(async () => {
  anvil = await startAnvil(PORT);
  // OpenInference's documented setup for ESM. The default (exclusive) mode replaces the SDK's trace processors, so
  // the SDK's own exporter to OpenAI is removed; offline.ts would answer it otherwise, and the tests check it is not
  // called. The SDK turns its tracing off when NODE_ENV is `test`, as under Vitest, so it is turned back on here:
  // without it, OpenInference records nothing.
  instrumentation = new OpenAIAgentsInstrumentation();
  instrumentation.manuallyInstrument(agents);
  agents.setTracingDisabled(false);
});

afterAll(async () => {
  instrumentation?.disable();
  await anvil?.stop();
});

beforeEach(() => anvil.tracing.exporter.reset());

/** Runs an agent whose scripted model calls the `pay_vendor` tool once, then answers. */
async function runAgent(workaround: boolean): Promise<void> {
  const wallet = await tracedWallet(anvil.rpcUrl);
  const pay = payVendor(wallet, workaround);
  // A tool that throws does not fail the run: the SDK hands the error to the model as the tool's result.
  let sent: Hex | undefined;
  const payVendorTool = agents.tool({
    name: TOOL_SPAN,
    description: 'Pays the vendor.',
    parameters: z.object({}),
    execute: async () => {
      sent = await pay();
      return sent;
    },
  });
  const agent = new agents.Agent({
    name: 'treasury',
    instructions: 'Pay the vendor when asked.',
    model: new ScriptedModel(),
    tools: [payVendorTool],
  });

  const result = await inAgentSpan(() => agents.run(agent, 'Pay the vendor.'));
  expect(sent).toMatch(/^0x[0-9a-f]{64}$/);
  expect(result.finalOutput).toBe('Paid the vendor.');
  await wallet.flush();
  // OpenInference ends its spans from the SDK's processor callbacks; this runs them before the spans are read.
  await agents.getGlobalTraceProvider().forceFlush();
  expect(offline.unexpected).toEqual([]);
}

describe('OpenInference OpenAI Agents instrumentation', () => {
  it('makes send and confirm children of an active span around the tool function', async () => {
    await runAgent(true);
    const spans = spansOf(anvil.tracing);
    // The documented workaround: the tool's function runs in an active span of its own.
    const toolSpan = spans.workaround?.spanContext().spanId;
    expect(toolSpan).toBeDefined();
    expect(spans.send.parentSpanContext?.spanId).toBe(toolSpan);
    expect(spans.confirm.parentSpanContext?.spanId).toBe(toolSpan);
    expect(spans.send.spanContext().traceId).toBe(spans.agent.spanContext().traceId);
  });

  it('records the spans of hashspan and OpenInference in the trace of the agent span', async () => {
    await runAgent(false);
    const spans = spansOf(anvil.tracing);
    const traceId = spans.agent.spanContext().traceId;
    expect(
      spans.openInference.some(
        (span) => span.attributes[OPENINFERENCE_KIND] === 'TOOL' && span.name === TOOL_SPAN,
      ),
    ).toBe(true);
    for (const span of spans.all) expect(span.spanContext().traceId).toBe(traceId);
    // Not asserted, so that a fix upstream does not break the test: with OpenInference's tool span not made active
    // (Arize-ai/openinference#3925), the send span's parent is the span that was active before the agent ran.
    console.info(
      `OpenAI Agents: parent of the send span without the workaround: ${spans.parentName(spans.send)}`,
    );
  });
});
