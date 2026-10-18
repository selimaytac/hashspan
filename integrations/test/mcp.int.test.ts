// An agent that calls a wallet tool of an MCP server over stdio, as in docs/integrations.md: the server is a child
// process of the agent, which is a child process of this test, so no context crosses between them in memory. Both
// processes start the OpenTelemetry Node SDK and export over OTLP (JSON) to a receiver in this test
// (otlp-receiver.ts); the server's tool sends on this file's Anvil. The test checks the parent of the server's `send`
// span:
// - without propagation (v1 SDK), `send` is the root of a trace of its own. This shows the setup can tell an
//   orphan from a child, so the other two results mean something;
// - with OpenInference's MCP instrumentation (v1 SDK, readme/mcp-instrumentation.ts) and with the hand-written
//   `_meta` propagation of the v2 SDK (readme/mcp-client.ts and readme/mcp-server.ts, run as written), `send` and
//   `confirm` are children of the agent's `pay_vendor` span.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { foundry } from 'viem/chains';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { type ReceivedSpan, startOtlpReceiver } from './otlp-receiver.js';

const { endpoint: otlpEndpoint, received, close: closeReceiver } = await startOtlpReceiver();

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: foundry.id,
});

afterAll(async () => {
  await closeReceiver();
  await instance.stop();
});

beforeEach(() => {
  received.length = 0;
});

/**
 * Runs an agent file with tsx's loader, from integrations/ so that tsx maps `@hashspan/*` to their sources
 * (tsconfig.json), and returns what it printed once both processes have exited.
 */
async function runAgent(file: string, env: Record<string, string> = {}): Promise<string> {
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

const chainSpan = (kind: 'send' | 'confirm') => `${kind} ${foundry.id}`;

/** The agent's tool span and the server's send and confirm spans, one of each. */
function spansOfRun(): Record<'tool' | 'send' | 'confirm', ReceivedSpan> {
  const one = (service: string, name: string) => {
    const spans = received.filter((span) => span.service === service && span.name === name);
    expect(spans, `${service} ${name} in [${received.map((s) => s.name)}]`).toHaveLength(1);
    return spans[0] as ReceivedSpan;
  };
  return {
    tool: one('my-agent', 'pay_vendor'),
    send: one('wallet-mcp', chainSpan('send')),
    confirm: one('wallet-mcp', chainSpan('confirm')),
  };
}

function expectChildrenOfTool({ tool, send, confirm }: ReturnType<typeof spansOfRun>): void {
  expect(tool.parentSpanId).toBeUndefined();
  for (const span of [send, confirm]) {
    expect(span.traceId).toBe(tool.traceId);
    expect(span.parentSpanId).toBe(tool.spanId);
  }
  expect(confirm.attributes['blockchain.tx.hash']).toBe(send.attributes['blockchain.tx.hash']);
  expect(confirm.attributes['blockchain.tx.status']).toBe('success');
}

describe('an MCP tool that sends a transaction, over stdio', () => {
  it('starts a trace of its own without propagation (v1 SDK)', { timeout: 60_000 }, async () => {
    expect(await runAgent('./mcp-v1/client.ts')).toMatch(/0x[0-9a-f]{64} success/);
    const { tool, send, confirm } = spansOfRun();
    expect(send.parentSpanId).toBeUndefined();
    expect(send.traceId).not.toBe(tool.traceId);
    expect(confirm.traceId).not.toBe(tool.traceId);
    expect(confirm.attributes['blockchain.tx.hash']).toBe(send.attributes['blockchain.tx.hash']);
  });

  it('joins the agent trace with OpenInference MCP instrumentation (v1 SDK)', {
    timeout: 60_000,
  }, async () => {
    const output = await runAgent('./mcp-v1/client.ts', { MCP_PROPAGATION: 'openinference' });
    expect(output).toMatch(/0x[0-9a-f]{64} success/);
    expectChildrenOfTool(spansOfRun());
  });

  it('joins the agent trace with _meta propagation by hand (v2 SDK, the docs example as written)', {
    timeout: 60_000,
  }, async () => {
    expect(await runAgent('./readme/mcp-client.ts')).toMatch(/0x[0-9a-f]{64} success/);
    expectChildrenOfTool(spansOfRun());
  });
});
