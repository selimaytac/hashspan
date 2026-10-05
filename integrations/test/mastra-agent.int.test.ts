// Runs the complete Mastra example of docs/integrations.md (readme/mastra-agent.ts) as written, against Anvil: its
// requests to http://127.0.0.1:8545 go to this file's Anvil, and its Node SDK records spans in memory instead of
// exporting them. Nothing leaves localhost (see offline.ts, a setup file).
import { context, propagation, trace } from '@opentelemetry/api';
import type { NodeSDKConfiguration, tracing } from '@opentelemetry/sdk-node';
import { foundry } from 'viem/chains';
import { afterAll, expect, it, vi } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { offline } from './offline.js';

const { spans } = vi.hoisted(() => ({ spans: [] as tracing.ReadableSpan[] }));

// The example's own SDK, with a span processor that keeps every ended span and without OTLP exporters.
vi.mock('@opentelemetry/sdk-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/sdk-node')>();
  class NodeSDK extends actual.NodeSDK {
    constructor(configuration: Partial<NodeSDKConfiguration> = {}) {
      super({
        ...configuration,
        spanProcessors: [
          {
            onStart: () => {},
            onEnd: (span) => void spans.push(span),
            forceFlush: async () => {},
            shutdown: async () => {},
          },
        ],
        metricReaders: [],
        logRecordProcessors: [],
      });
    }
  }
  return { ...actual, NodeSDK };
});

const EXAMPLE_RPC_URL = 'http://127.0.0.1:8545';
const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: foundry.id,
});

const offlineFetch = globalThis.fetch;
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  return offlineFetch(
    url.startsWith(EXAMPLE_RPC_URL) ? url.replace(EXAMPLE_RPC_URL, rpcUrl) : input,
    init,
  );
});

afterAll(async () => {
  vi.stubGlobal('fetch', offlineFetch);
  trace.disable();
  context.disable();
  propagation.disable();
  await instance.stop();
});

const spanNamed = (name: string): tracing.ReadableSpan => {
  const span = spans.find((s) => s.name === name);
  if (!span) throw new Error(`no span named "${name}" in [${spans.map((s) => s.name)}]`);
  return span;
};

it('records send and confirm under the execute_tool span of the agent trace', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('./readme/mastra-agent.js');
  expect(log).toHaveBeenCalledWith('Paid the vendor 0.01 ETH.');
  log.mockRestore();

  const tool = spanNamed('execute_tool pay_vendor');
  const send = spanNamed(`send ${foundry.id}`);
  const confirm = spanNamed(`confirm ${foundry.id}`);
  for (const span of [send, confirm]) {
    expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(span.spanContext().traceId).toBe(tool.spanContext().traceId);
  }
  expect(confirm.attributes['blockchain.tx.hash']).toBe(send.attributes['blockchain.tx.hash']);
  expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  const root = spans.find(
    (s) => s.spanContext().traceId === tool.spanContext().traceId && !s.parentSpanContext,
  );
  expect(root?.name).toBe('invoke_agent treasury');
  expect(offline.unexpected).toEqual([]);
});
