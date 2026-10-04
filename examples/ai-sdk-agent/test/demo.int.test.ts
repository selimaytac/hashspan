import { OpenTelemetry } from '@ai-sdk/otel';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerTelemetry } from 'ai';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startAnvil } from '../../../packages/viem/test/start-anvil.js';

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(async () => {
  process.env.RPC_URL = rpcUrl;
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

it('traces the agent run down to its transactions', async () => {
  const { runDemo } = await import('../src/demo.js');
  const { toolResults } = await runDemo();
  expect(toolResults.map((r) => r.toolName)).toEqual(['pay_vendor', 'withdraw_from_vault']);

  const spans = exporter.getFinishedSpans();
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  const parentOf = (span: (typeof spans)[number]) =>
    span.parentSpanContext ? byId.get(span.parentSpanContext.spanId) : undefined;

  const sends = spans.filter((s) => s.name === 'send 31337');
  const confirms = spans.filter((s) => s.name === 'confirm 31337');
  expect(sends).toHaveLength(2);
  expect(confirms).toHaveLength(2);

  // Every transaction span sits under the tool call that sent it, inside one agent trace.
  for (const span of [...sends, ...confirms]) {
    expect(parentOf(span)?.name).toMatch(/^execute_tool /);
    expect(span.spanContext().traceId).toBe(sends[0]?.spanContext().traceId);
    expect(span.attributes['gen_ai.agent.name']).toBe('treasury-agent');
  }

  const withdrawal = confirms.find((s) => s.attributes['blockchain.tx.status'] === 'reverted');
  expect(withdrawal?.attributes['blockchain.tx.revert.reason']).toBe(
    'WithdrawalLimitExceeded(100000000000000000, 1000000000000000000)',
  );
  expect(parentOf(withdrawal as never)?.name).toBe('execute_tool withdraw_from_vault');
});
