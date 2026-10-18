// propagateTraceContext() through viem's http() to Anvil, behind an HTTP proxy that keeps the trace headers and
// JSON-RPC methods of every request it passes on: the header of each request names its JSON-RPC span.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createWalletClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { propagateTraceContext, traceTransport, withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

// Anvil's first test account, which Anvil signs for.
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = '0x00000000000000000000000000000000000000cc';

interface Seen {
  methods: string[];
  traceparent: string | string[] | undefined;
  tracestate: string | string[] | undefined;
  baggage: string | string[] | undefined;
}

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
const seen: Seen[] = [];
const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
const proxy = createServer(async (request, response) => {
  const body = await readBody(request);
  const parsed = JSON.parse(body) as { method: string } | { method: string }[];
  seen.push({
    methods: (Array.isArray(parsed) ? parsed : [parsed]).map((call) => call.method),
    traceparent: request.headers.traceparent,
    tracestate: request.headers.tracestate,
    baggage: request.headers.baggage,
  });
  const answer = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  response.writeHead(answer.status, { 'Content-Type': 'application/json' });
  response.end(await answer.text());
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const PROXY_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

afterAll(async () => {
  await new Promise((resolve) => proxy.close(resolve));
  await instance.stop();
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
  seen.length = 0;
});
afterEach(async () => {
  await tracing.teardown();
});

/** Sends a transfer and waits for its receipt through `transport`, with the clients of one `withHashspan()`. */
async function transfer(transport: ReturnType<typeof traceTransport>): Promise<void> {
  const hashspan = withHashspan();
  const wallet = createWalletClient({ account: ACCOUNT, chain: anvil, transport }).extend(hashspan);
  const reader = createPublicClient({ chain: anvil, transport, pollingInterval: 50 }).extend(
    hashspan,
  );
  const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
  await reader.waitForTransactionReceipt({ hash });
  await hashspan.flush();
}

// viem 2.21.25 is the first release whose `onFetchRequest` gets the request init and whose result it sends.
describe.runIf(viemAtLeast('2.21.25'))('propagateTraceContext() against Anvil', () => {
  it("sends each request's JSON-RPC span as its traceparent, in the transaction's trace", async () => {
    await transfer(traceTransport(http(PROXY_URL, { onFetchRequest: propagateTraceContext() })));
    const send = tracing.spanNamed('send 31337').spanContext();
    const rpc = tracing.spans().filter((s) => s.attributes['rpc.system.name'] === 'jsonrpc');
    expect(rpc.map((s) => s.name)).toContain('eth_sendTransaction');
    expect(seen).toHaveLength(rpc.length);
    for (const request of seen) {
      expect(request.methods).toHaveLength(1);
      expect(request.tracestate).toBeUndefined();
      expect(request.baggage).toBeUndefined();
      const [version, traceId, spanId, flags] = String(request.traceparent).split('-');
      expect([version, flags]).toEqual(['00', '01']);
      const span = rpc.find((s) => s.spanContext().spanId === spanId);
      expect(span?.name, String(request.traceparent)).toBe(request.methods[0]);
      expect(traceId).toBe(span?.spanContext().traceId);
    }
    // The send's requests carry the send's trace.
    const sent = seen.find((request) => request.methods[0] === 'eth_sendTransaction');
    expect(String(sent?.traceparent).split('-')[1]).toBe(send.traceId);
  });

  it('sends no header without the hook', async () => {
    await transfer(traceTransport(http(PROXY_URL)));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((request) => request.traceparent !== undefined)).toEqual([]);
  });
});
