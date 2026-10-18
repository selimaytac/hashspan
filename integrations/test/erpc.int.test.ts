// An agent that sends through the RPC gateway eRPC, as in docs/integrations.md: eRPC runs in front of this file's
// Anvil with the `erpc.yaml` of the docs, read from the docs and changed only in its addresses (and, for the control, its
// sample rate), and exports its spans over OTLP/HTTP (protobuf) to a receiver in this test. The agent is
// readme/erpc-agent.ts, run as written in a child process with tsx's loader, exporting to the same receiver. The test
// checks where eRPC's server span `Http.ReceivedRequest` of each JSON-RPC request lands:
// - with the undici instrumentation, in the agent's trace, under the undici `POST` span of the request, which is a
//   child of hashspan's JSON-RPC span (the double client span of docs/backends.md);
// - without it (erpc/no-undici.ts, at sample rate 1 so that eRPC records requests without a parent), in traces of
//   its own. This shows the setup can tell the two apart, so the first result means something.
// eRPC is the pinned binary of scripts/install-erpc.sh (`make tools`), on 127.0.0.1 only, with metrics off.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { foundry } from 'viem/chains';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { type ReceivedSpan, startOtlpReceiver } from './otlp-receiver.js';

const ERPC = new URL('../../.tools/bin/erpc', import.meta.url).pathname;
if (!existsSync(ERPC))
  throw new Error('eRPC is not installed: run ./scripts/install-erpc.sh (make tools)');

// viem's requests for one transfer from a local account and the wait for its receipt, at least once each; how often
// it polls for the transaction and its receipt depends on timing.
const METHODS = [
  'eth_fillTransaction',
  'eth_sendRawTransaction',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
];
const HASH = /^(0x[0-9a-f]{64}) success$/m;

const { endpoint: otlpEndpoint, received, close: closeReceiver } = await startOtlpReceiver();
const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: foundry.id,
});
const workDir = mkdtempSync(join(tmpdir(), 'hashspan-erpc-'));

afterAll(async () => {
  await closeReceiver();
  await instance.stop();
  rmSync(workDir, { recursive: true, force: true });
});

/** The `erpc.yaml` block of the eRPC section of docs/integrations.md. */
function docsConfig(): string {
  const docs = readFileSync(new URL('../../docs/integrations.md', import.meta.url), 'utf8');
  const section = docs.split('\n## RPC gateways (eRPC)\n')[1]?.split('\n## ')[0] ?? '';
  const block = section.match(/^```yaml\n([\s\S]*?)^```$/m)?.[1];
  if (block === undefined)
    throw new Error('no yaml block in the eRPC section of docs/integrations.md');
  return block;
}

/** Replaces `from`, which must occur exactly once in the config. */
function replaceOnce(config: string, from: string, to: string): string {
  expect(config.split(from), `"${from}" once in the docs' erpc.yaml`).toHaveLength(2);
  return config.replace(from, to);
}

/** A port that was free a moment ago: eRPC does not print the port it bound with port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

type RunningErpc = { process: ChildProcess; url: string; output: () => string };

/** Starts eRPC with the docs' config on a free port; tries another port if it exits before it answers. */
async function startErpc(sampleRate?: string): Promise<RunningErpc> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    let config = docsConfig();
    config = replaceOnce(config, 'httpPortV4: 4000', `httpPortV4: ${port}`);
    config = replaceOnce(
      config,
      'endpoint: 127.0.0.1:4318',
      `endpoint: ${new URL(otlpEndpoint).host}`,
    );
    config = replaceOnce(config, 'endpoint: http://127.0.0.1:8545', `endpoint: ${rpcUrl}`);
    if (sampleRate !== undefined)
      config = replaceOnce(config, 'sampleRate: 0.1', `sampleRate: ${sampleRate}`);
    writeFileSync(join(workDir, 'erpc.yaml'), config);
    const child = spawn(ERPC, ['--require-config', '--config', 'erpc.yaml'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk: Buffer) => {
      log += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      log += chunk.toString('utf8');
    });
    const url = `http://127.0.0.1:${port}/main/evm/${foundry.id}`;
    if (await answers(child, url)) return { process: child, url, output: () => log };
    child.kill('SIGKILL');
    if (attempt === 3) throw new Error(`eRPC did not start:\n${log}`);
  }
}

/** Whether eRPC answers `eth_chainId` with the chain id before it exits or 30 seconds pass. */
async function answers(child: ChildProcess, url: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (((await response.json()) as { result?: string }).result === '0x7a69') return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

let erpc: RunningErpc | undefined;

beforeEach(() => {
  received.length = 0;
});

afterEach(() => {
  // Its spans are in by now; a SIGTERM would wait 20 seconds (waitBeforeShutdown and waitAfterShutdown).
  erpc?.process.kill('SIGKILL');
  erpc = undefined;
});

/** Runs an agent file with tsx's loader, from integrations/ (tsconfig.json maps `@hashspan/*` to their sources). */
async function runAgent(file: string, url: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', new URL(file, import.meta.url).pathname],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        RPC_URL: url,
        OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
      },
      timeout: 50_000,
    },
  );
  const hash = stdout.match(HASH)?.[1];
  expect(hash, stdout).toBeDefined();
  return hash as string;
}

/** The agent's spans of the run: its tool span, send and confirm, and its JSON-RPC spans. */
function agentSpans(): { tool: ReceivedSpan; rpc: ReceivedSpan[]; spans: ReceivedSpan[] } {
  const spans = received.filter((span) => span.service === 'my-agent');
  const tools = spans.filter((span) => span.name === 'pay_vendor');
  expect(tools, `${spans.map((span) => span.name)}`).toHaveLength(1);
  const tool = tools[0] as ReceivedSpan;
  expect(spans.every((span) => span.traceId === tool.traceId)).toBe(true);
  for (const kind of ['send', 'confirm'])
    expect(spans.filter((span) => span.name === `${kind} ${foundry.id}`)).toHaveLength(1);
  const rpc = spans.filter((span) => span.attributes['rpc.system.name'] === 'jsonrpc');
  for (const method of METHODS) expect(rpc.map((span) => span.name)).toContain(method);
  return { tool, rpc, spans };
}

const erpcSpans = () => received.filter((span) => span.service === 'erpc');

/** eRPC's server spans of HTTP requests, each with the JSON-RPC method of the `Request.Handle` span under it. */
function erpcRequests(): { server: ReceivedSpan; method: unknown }[] {
  const spans = erpcSpans();
  return spans
    .filter((span) => span.name === 'Http.ReceivedRequest')
    .map((server) => ({
      server,
      method: spans.find(
        (span) => span.name === 'Request.Handle' && span.parentSpanId === server.spanId,
      )?.attributes['request.method'],
    }));
}

/** Waits for eRPC's batched export (about every 5 seconds) until `done` holds. */
async function waitFor(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${describe()}\n${erpc?.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('eRPC in front of Anvil, with the agent of docs/integrations.md', () => {
  it('puts eRPC server spans in the agent trace, under the undici POST span of each request', {
    timeout: 90_000,
  }, async () => {
    erpc = await startErpc();
    const hash = await runAgent('./readme/erpc-agent.ts', erpc.url);
    const { tool, rpc, spans } = agentSpans();
    expect(spans.find((span) => span.name === `send ${foundry.id}`)?.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
    });
    const posts = rpc.map((parent) => {
      const children = spans.filter((span) => span.parentSpanId === parent.spanId);
      expect(
        children.map((span) => span.name),
        parent.name,
      ).toEqual(['POST']);
      return children[0] as ReceivedSpan;
    });
    // Each request's server span is a child of its POST span, and handles the request's method.
    const requestOf = (post: ReceivedSpan) =>
      erpcRequests().find(({ server }) => server.parentSpanId === post.spanId);
    await waitFor(
      () => posts.every((post) => requestOf(post)?.method !== undefined),
      () =>
        `${posts.filter((post) => requestOf(post)).length} of ${posts.length} requests in eRPC's spans`,
    );
    for (const [index, parent] of rpc.entries()) {
      const request = requestOf(posts[index] as ReceivedSpan);
      expect(request?.server.traceId).toBe(tool.traceId);
      expect(request?.method, parent.name).toBe(parent.name);
    }
    // eRPC's own spans go on below its server span, down to its call to Anvil.
    expect(
      received.some(
        (span) =>
          span.traceId === tool.traceId && span.name === 'HttpJsonRpcClient.sendSingleRequest',
      ),
    ).toBe(true);
  });

  it('leaves eRPC server spans in traces of their own without the undici instrumentation (control)', {
    timeout: 90_000,
  }, async () => {
    erpc = await startErpc('1');
    await runAgent('./erpc/no-undici.ts', erpc.url);
    const { tool, rpc, spans } = agentSpans();
    expect(spans.some((span) => span.name === 'POST')).toBe(false);
    // As many server spans for each method as the agent sent requests, each the root of a trace of its own.
    const roots = (method: string) =>
      erpcRequests().filter(
        (request) => request.method === method && request.server.parentSpanId === undefined,
      );
    const sent = (method: string) => rpc.filter((span) => span.name === method).length;
    await waitFor(
      () => METHODS.every((method) => roots(method).length >= sent(method)),
      () => METHODS.map((method) => `${method} ${roots(method).length}/${sent(method)}`).join(', '),
    );
    expect(erpcRequests().filter(({ server }) => server.parentSpanId !== undefined)).toEqual([]);
    expect(erpcSpans().some((span) => span.traceId === tool.traceId)).toBe(false);
  });
});
