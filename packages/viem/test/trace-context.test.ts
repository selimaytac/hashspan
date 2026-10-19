import {
  context,
  createTraceState,
  diag,
  propagation,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { propagateTraceContext, traceTransport, withHashspan } from '../src/index.js';
import { FROM, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await tracing.teardown();
});

type Init = { body?: unknown; headers?: unknown; method?: string };
type Hook = (request: unknown, init?: Init) => Init | undefined;
const hook = (): Hook => propagateTraceContext() as unknown as Hook;
const init = (headers: unknown = { 'Content-Type': 'application/json' }): Init => ({
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }),
  headers,
});

/**
 * A client whose transport calls the hook the way viem's `http()` does, inside the request, and keeps what it
 * returned; the request answers `0x1`. It runs on every viem release of the peer range, unlike `http()`'s hook.
 */
function hooked(options: { methods?: (method: string) => boolean; given?: () => Init } = {}) {
  const returned: (Init | undefined)[] = [];
  const onFetchRequest = hook();
  const transport = custom({
    request: async () => {
      returned.push(onFetchRequest(undefined, (options.given ?? init)()));
      return '0x1';
    },
  });
  const client = createPublicClient({
    chain: base,
    transport: traceTransport(transport, options.methods ? { methods: options.methods } : {}),
  });
  return { client, returned };
}

const headersOf = (returned: Init | undefined) => returned?.headers as Record<string, string>;
const rpcSpan = (name: string) => tracing.spanNamed(name).spanContext();

describe('propagateTraceContext', () => {
  it("sends the JSON-RPC span's context as traceparent, keeping the request's headers", async () => {
    const { client, returned } = hooked();
    await client.request({ method: 'eth_blockNumber' });
    const span = rpcSpan('eth_blockNumber');
    expect(returned).toHaveLength(1);
    expect(headersOf(returned[0])).toEqual({
      'Content-Type': 'application/json',
      traceparent: `00-${span.traceId}-${span.spanId}-01`,
    });
    expect(returned[0]).toMatchObject({ method: 'POST', body: init().body });
  });

  it('passes on the sampled flag and the trace state of the trace', async () => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.NONE,
      isRemote: true,
      traceState: createTraceState('vendor=value,other=1'),
    });
    const { client, returned } = hooked();
    await context.with(parent, () => client.request({ method: 'eth_blockNumber' }));
    const headers = headersOf(returned[0]);
    expect(headers.traceparent).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-00$/);
    expect(headers.traceparent).not.toContain('b7ad6b7169203331');
    expect(headers.tracestate).toBe('vendor=value,other=1');
  });

  it('never sends baggage, whatever the global propagator does', async () => {
    const withBaggage = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ 'user.id': { value: 'alice' } }),
    );
    // The propagator setupTracing() registers sends baggage.
    const carrier: Record<string, string> = {};
    propagation.inject(withBaggage, carrier);
    expect(carrier.baggage).toBe('user.id=alice');

    const { client, returned } = hooked();
    await context.with(withBaggage, () => client.request({ method: 'eth_blockNumber' }));
    expect(Object.keys(headersOf(returned[0])).sort()).toEqual(['Content-Type', 'traceparent']);
  });

  it('adds nothing outside a JSON-RPC span of traceTransport()', async () => {
    const onFetchRequest = hook();
    expect(onFetchRequest(undefined, init())).toBeUndefined();
    await trace.getTracer('test').startActiveSpan('tool', async (span) => {
      expect(onFetchRequest(undefined, init())).toBeUndefined();
      span.end();
    });
  });

  it('adds nothing for a method that `methods` left out, even under a send span', async () => {
    const returned: (Init | undefined)[] = [];
    const methods: string[] = [];
    const onFetchRequest = hook();
    const { transport } = mockTransport({
      onRequest: (method) => {
        methods.push(method);
        returned.push(onFetchRequest(undefined, init()));
      },
    });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: traceTransport(transport, {
        methods: (method) => method !== 'eth_sendTransaction',
      }),
    }).extend(withHashspan());
    await wallet.sendTransaction({ to: TO });
    expect(tracing.spanNamed('send 8453')).toBeDefined();
    const sent = methods.indexOf('eth_sendTransaction');
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(returned[sent]).toBeUndefined();
    // The methods that kept their span got a header.
    for (const [index, value] of returned.entries()) {
      if (index !== sent) expect(headersOf(value).traceparent, methods[index]).toBeDefined();
    }
  });

  it('keeps a traceparent the request already has, in any letter case and header form', async () => {
    for (const headers of [
      { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
      { TraceParent: '00-11111111111111111111111111111111-2222222222222222-01' },
      [['Traceparent', '00-11111111111111111111111111111111-2222222222222222-01']],
      new Headers({ traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }),
    ]) {
      const { client, returned } = hooked({ given: () => init(headers) });
      await client.request({ method: 'eth_blockNumber' });
      expect(returned, JSON.stringify(headers)).toEqual([undefined]);
    }
  });

  it('copies headers given as pairs or a Headers object into a plain object', async () => {
    for (const headers of [[['x-api', 'a']], new Headers({ 'x-api': 'a' })]) {
      const { client, returned } = hooked({ given: () => init(headers) });
      await client.request({ method: 'eth_blockNumber' });
      expect(Object.keys(headersOf(returned[0])).sort()).toEqual(['traceparent', 'x-api']);
    }
  });

  it("drops a tracestate of the caller's, which belongs to another traceparent", async () => {
    const { client, returned } = hooked({ given: () => init({ TraceState: 'stale=1' }) });
    await client.request({ method: 'eth_blockNumber' });
    expect(Object.keys(headersOf(returned[0]))).toEqual(['traceparent']);
  });

  it('adds nothing to an HTTP request of several JSON-RPC requests, and adds it to a batch of one', async () => {
    const batch = (size: number) => () => ({
      ...init(),
      body: JSON.stringify(
        Array.from({ length: size }, (_, id) => ({ jsonrpc: '2.0', id, method: 'eth_chainId' })),
      ),
    });
    const several = hooked({ given: batch(2) });
    await several.client.request({ method: 'eth_blockNumber' });
    expect(several.returned).toEqual([undefined]);
    const one = hooked({ given: batch(1) });
    await one.client.request({ method: 'eth_blockNumber' });
    expect(headersOf(one.returned[0]).traceparent).toBeDefined();
  });

  it('adds nothing and warns once when viem passes no init (viem below 2.21.25)', async () => {
    const warn = vi.spyOn(diag, 'warn');
    const onFetchRequest = hook();
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(
        custom({
          request: async () => {
            expect(onFetchRequest(undefined)).toBeUndefined();
            expect(onFetchRequest(undefined)).toBeUndefined();
            return '0x1';
          },
        }),
      ),
    });
    await client.request({ method: 'eth_blockNumber' });
    // Once per process: no other test of this file calls the hook without an init.
    expect(warn.mock.calls).toEqual([
      ['hashspan: propagateTraceContext() needs viem 2.21.25 or later; no header sent'],
    ]);
  });

  it('never throws, and sends the request unchanged, when the headers cannot be read', async () => {
    const error = vi.spyOn(diag, 'error');
    const hostile = {};
    Object.defineProperty(hostile, 'x-api', {
      enumerable: true,
      get() {
        throw new Error('trap');
      },
    });
    const { client, returned } = hooked({ given: () => init(hostile) });
    await client.request({ method: 'eth_blockNumber' });
    expect(returned).toEqual([undefined]);
    expect(error).toHaveBeenCalledWith(
      'hashspan: failed to add the trace context to a request (Error)',
    );
  });
});

/** A stand-in for `fetch` that answers every JSON-RPC request `0x1` and keeps the headers it was sent. */
function stubFetch(): Record<string, string>[] {
  const sent: Record<string, string>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, given: RequestInit) => {
    sent.push(Object.fromEntries(new Headers(given.headers).entries()));
    const body = JSON.parse(String(given.body)) as { id: number } | { id: number }[];
    const answer = (request: { id: number }) => ({ jsonrpc: '2.0', id: request.id, result: '0x1' });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return sent;
}

// viem 2.21.25 is the first release whose `onFetchRequest` gets the request init and whose result it sends.
describe.runIf(viemAtLeast('2.21.25'))("propagateTraceContext with viem's http()", () => {
  it('sends traceparent on each request of a traced http() transport, and nothing without the hook', async () => {
    const sent = stubFetch();
    const traced = createPublicClient({
      chain: base,
      transport: traceTransport(
        http('http://127.0.0.1:1/rpc', { onFetchRequest: propagateTraceContext() }),
      ),
    });
    await traced.request({ method: 'eth_blockNumber' });
    const span = rpcSpan('eth_blockNumber');
    expect(sent[0]?.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
    expect(sent[0]?.['content-type']).toBe('application/json');

    const plain = createPublicClient({
      chain: base,
      transport: traceTransport(http('http://127.0.0.1:1/rpc')),
    });
    await plain.request({ method: 'eth_gasPrice' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty('traceparent');
  });

  it('sends no traceparent for a batch of several requests (batch: true)', async () => {
    const sent = stubFetch();
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(
        http('http://127.0.0.1:1/rpc', { batch: true, onFetchRequest: propagateTraceContext() }),
      ),
    });
    await Promise.all([
      client.request({ method: 'eth_blockNumber' }),
      client.request({ method: 'eth_gasPrice' }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('traceparent');
  });
});
