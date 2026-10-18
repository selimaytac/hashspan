// The Genkit setup of docs/integrations.md, run against Anvil: a Genkit agent with a scripted model (no API key)
// calls a tool defined with `defineTool` that sends a transaction and waits for its receipt. Each run is a child
// process with tsx's loader, from integrations/ so that tsx maps `@hashspan/*` to their sources (tsconfig.json),
// exporting over OTLP to a receiver in this test: Genkit's settings and OpenTelemetry's global registrations last
// for the whole process, so the setups cannot share one. readme/genkit-agent.ts runs as written; genkit/control.ts
// checks the other setups the docs describe (see that file).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { foundry } from 'viem/chains';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { type ReceivedSpan, startOtlpReceiver } from './otlp-receiver.js';

const HASH = /^(0x[0-9a-f]{64}) success$/m;

const { endpoint: otlpEndpoint, received, close } = await startOtlpReceiver();
const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: foundry.id,
});

afterAll(async () => {
  await close();
  await instance.stop();
});

beforeEach(() => {
  received.length = 0;
});

/** Runs a file with tsx's loader and returns what it printed once it has exited on its own. */
async function run(file: string, env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', new URL(file, import.meta.url).pathname],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        RPC_URL: rpcUrl,
        OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        ...env,
      },
      timeout: 50_000,
    },
  );
  return stdout;
}

const spanNamed = (name: string): ReceivedSpan => {
  const span = received.find((s) => s.name === name);
  if (!span) throw new Error(`no span named "${name}" in [${received.map((s) => s.name)}]`);
  return span;
};
const parentOf = (span: ReceivedSpan): ReceivedSpan | undefined =>
  received.find((s) => s.spanId === span.parentSpanId);

/** Genkit's span of the tool call, found by its attributes rather than by its name alone. */
function toolSpan(): ReceivedSpan {
  const tools = received.filter(
    (s) =>
      s.attributes['genkit:type'] === 'action' &&
      s.attributes['genkit:metadata:subtype'] === 'tool',
  );
  expect(tools.map((s) => s.name)).toEqual(['pay_vendor']);
  return tools[0] as ReceivedSpan;
}

/** Asserts that the send and confirm spans of `hash` are children of Genkit's tool span, and returns that span. */
function expectUnderTool(output: string): ReceivedSpan {
  const hash = output.match(HASH)?.[1];
  const send = spanNamed(`send ${foundry.id}`);
  const confirm = spanNamed(`confirm ${foundry.id}`);
  if (hash !== undefined) expect(send.attributes['blockchain.tx.hash']).toBe(hash);
  expect(confirm.attributes['blockchain.tx.hash']).toBe(send.attributes['blockchain.tx.hash']);
  expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  const tool = toolSpan();
  for (const span of [send, confirm]) {
    expect(span.parentSpanId).toBe(tool.spanId);
    expect(span.traceId).toBe(tool.traceId);
    expect(span.service).toBe('my-agent');
  }
  return tool;
}

/** The root of the span's trace, walking up through the spans received. */
function rootOf(span: ReceivedSpan): ReceivedSpan {
  let current = span;
  for (let parent = parentOf(current); parent; parent = parentOf(current)) current = parent;
  return current;
}

describe('Genkit', () => {
  it('runs the example of the docs as written: send and confirm under the tool span, in the generate trace', async () => {
    const output = await run('./readme/genkit-agent.ts');
    expect(output).toContain('Paid the vendor 0.01 ETH.');
    const tool = expectUnderTool(output);
    const root = rootOf(tool);
    expect(root.name).toBe('generate');
    expect(root.parentSpanId).toBeUndefined();
    expect(root.attributes['genkit:isRoot']).toBe(true);
  });

  it("without disableGenkitOTelInitialization(), started first, this process's SDK still records the trace", async () => {
    const output = await run('./genkit/control.ts', { GENKIT_SETUP: 'default' });
    expect(output).toMatch(HASH);
    expect(rootOf(expectUnderTool(output)).name).toBe('generate');
  });

  it("when Genkit runs before this process's SDK starts, Genkit's provider wins and nothing reaches OTLP", async () => {
    const output = await run('./genkit/control.ts', { GENKIT_SETUP: 'genkit-first' });
    // The tool ran and the transaction was confirmed, but no span of it was exported.
    expect(output).toMatch(HASH);
    expect(output).toContain('Paid the vendor 0.01 ETH.');
    expect(received).toEqual([]);
  });

  it('inside an active span of the app, generate starts a trace of its own', async () => {
    const output = await run('./genkit/control.ts', { GENKIT_SETUP: 'request-span' });
    const tool = expectUnderTool(output);
    const request = spanNamed('handle_request');
    expect(request.parentSpanId).toBeUndefined();
    expect(tool.traceId).not.toBe(request.traceId);
    expect(rootOf(tool).name).toBe('generate');
  });

  it('with disableOTelRootSpanDetection(), generate joins the active span of the app', async () => {
    const output = await run('./genkit/control.ts', { GENKIT_SETUP: 'request-span-joined' });
    const tool = expectUnderTool(output);
    const request = spanNamed('handle_request');
    expect(tool.traceId).toBe(request.traceId);
    expect(rootOf(tool).spanId).toBe(request.spanId);
  });
});
