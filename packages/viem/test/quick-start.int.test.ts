// The README quick start, run as a new user runs it: the `agent.ts` block taken from README.md as it is, started with
// tsx in a process of its own, exporting over OTLP with the SDK's defaults to a receiver in this file. Only the RPC
// URL is changed, to this file's Anvil. The README's sentences about the result are what the assertions check.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type StartedAnvil, startAnvil } from './start-anvil.js';

const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const README_RPC_URL = "'http://127.0.0.1:8545'";

/** The `ts` block of README.md that starts the SDK: the quick start's `agent.ts`. */
function quickStartSource(): string {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] as string);
  const agent = blocks.filter((block) => block.includes('new NodeSDK('));
  expect(agent, 'README.md has one ts block that starts the SDK').toHaveLength(1);
  return agent[0] as string;
}

type OtlpValue = { stringValue?: string };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  links?: { spanId: string }[];
};
type OtlpTraces = {
  resourceSpans: {
    resource: { attributes: { key: string; value: OtlpValue }[] };
    scopeSpans: { spans: OtlpSpan[] }[];
  }[];
};

const received: { service: string | undefined; span: OtlpSpan }[] = [];
let receiver: Server;
let anvil: StartedAnvil;

beforeAll(async () => {
  anvil = await startAnvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  });
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.url === '/v1/traces') {
        for (const resourceSpans of (JSON.parse(body) as OtlpTraces).resourceSpans) {
          const service = resourceSpans.resource.attributes.find((a) => a.key === 'service.name');
          for (const scopeSpans of resourceSpans.scopeSpans) {
            for (const span of scopeSpans.spans) {
              received.push({ service: service?.value.stringValue, span });
            }
          }
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => receiver?.close(resolve));
  await anvil?.instance.stop();
});

it('gives the trace the README describes: pay_vendor with send and confirm children, the confirm linked', async () => {
  const source = quickStartSource();
  expect(source.split(README_RPC_URL), 'the quick start names the RPC URL once').toHaveLength(2);

  // Under test/fixtures, so that viem and the OpenTelemetry packages resolve as they do from a user's project.
  const directory = mkdtempSync(join(fixtures, 'quick-start-'));
  try {
    const file = join(directory, 'agent.mts');
    writeFileSync(file, source.replace(README_RPC_URL, `'${anvil.rpcUrl}'`));
    const { port } = receiver.address() as AddressInfo;
    const { stdout, stderr } = await run(
      process.execPath,
      [tsx, '--tsconfig', join(fixtures, 'tsconfig.json'), file],
      {
        timeout: 60_000,
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          // JSON instead of the default protobuf, so that this file can read what arrives.
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        },
      },
    );
    // "prints nothing on success"
    expect({ stdout, stderr }).toEqual({ stdout: '', stderr: '' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const named = (name: string) => {
    const matching = received.filter((r) => r.span.name === name);
    expect(matching, `one span named "${name}"`).toHaveLength(1);
    return matching[0] as (typeof received)[number];
  };
  const tool = named('pay_vendor');
  const send = named('send 31337');
  const confirm = named('confirm 31337');

  expect(received.every((r) => r.service === 'my-agent')).toBe(true);
  expect(tool.span.parentSpanId ?? '').toBe('');
  for (const child of [send, confirm]) {
    expect(child.span.traceId).toBe(tool.span.traceId);
    expect(child.span.parentSpanId).toBe(tool.span.spanId);
  }
  expect(confirm.span.links?.map((link) => link.spanId)).toEqual([send.span.spanId]);
}, 90_000);
