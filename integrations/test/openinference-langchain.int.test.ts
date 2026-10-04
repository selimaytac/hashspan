// The LangChain JS setup of docs/integrations.md ("Agent frameworks"): a LangChain agent instrumented by
// OpenInference, with a scripted model and a tool that sends a transaction on Anvil. Nothing leaves localhost (see
// offline.ts, a setup file).
import { LangChainInstrumentation } from '@arizeai/openinference-instrumentation-langchain';
import * as CallbackManagerModule from '@langchain/core/callbacks/manager';
import { AIMessage, createAgent, fakeModel, tool } from 'langchain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let instrumentation: LangChainInstrumentation;

beforeAll(async () => {
  anvil = await startAnvil();
  // OpenInference's documented setup for ESM: the callback manager is instrumented by hand.
  instrumentation = new LangChainInstrumentation();
  instrumentation.manuallyInstrument(CallbackManagerModule);
});

afterAll(async () => {
  instrumentation?.disable();
  await anvil?.stop();
});

beforeEach(() => anvil.tracing.exporter.reset());

/** Runs a LangChain agent whose scripted model calls the `pay_vendor` tool once, then answers. */
async function runAgent(workaround: boolean): Promise<void> {
  const wallet = await tracedWallet(anvil.rpcUrl);
  const payVendorTool = tool(payVendor(wallet, workaround), {
    name: TOOL_SPAN,
    description: 'Pays the vendor.',
    schema: z.object({}),
  });
  const model = fakeModel()
    .respondWithTools([{ name: TOOL_SPAN, args: {} }])
    .respond(new AIMessage('Paid the vendor.'));
  const agent = createAgent({ model, tools: [payVendorTool] });

  const result = await inAgentSpan(() =>
    agent.invoke({ messages: [{ role: 'user', content: 'Pay the vendor.' }] }),
  );
  // A tool that throws does not fail the run: LangChain hands the error to the model as the tool's result.
  const toolResult = result.messages.find((message) => message.type === 'tool');
  expect(toolResult?.text).toMatch(/^0x[0-9a-f]{64}$/);
  expect(result.messages.at(-1)?.text).toBe('Paid the vendor.');
  await wallet.flush();
  expect(offline.unexpected).toEqual([]);
}

describe('OpenInference LangChain instrumentation', () => {
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
    // OpenInference records the tool call as a TOOL span (named after the tool) and the agent run as a chain.
    expect(
      spans.openInference.some(
        (span) => span.attributes[OPENINFERENCE_KIND] === 'TOOL' && span.name === TOOL_SPAN,
      ),
    ).toBe(true);
    for (const span of spans.all) expect(span.spanContext().traceId).toBe(traceId);
    // Not asserted, so that a fix upstream does not break the test: with OpenInference's tool span not made active
    // (Arize-ai/openinference#1103), the send span's parent is the span that was active before the agent ran.
    console.info(
      `LangChain: parent of the send span without the workaround: ${spans.parentName(spans.send)}`,
    );
  });
});
