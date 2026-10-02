import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  createPublicClient,
  createWalletClient,
  custom,
  InvalidParamsRpcError,
  type Transport,
} from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceTransport, withHashspan } from '../src/index.js';
import { FROM, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const rpcSpans = () => tracing.spans().filter((s) => s.attributes['rpc.system.name'] === 'jsonrpc');

describe('traceTransport', () => {
  it('records a client span per request, named after its method', async () => {
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(mockTransport().transport),
    });

    expect(await client.getBlockNumber()).toBe(0x7bn);
    const [span] = rpcSpans();
    expect(span?.name).toBe('eth_blockNumber');
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toEqual({
      'rpc.system.name': 'jsonrpc',
      'rpc.method': 'eth_blockNumber',
      'jsonrpc.protocol.version': '2.0',
      'blockchain.chain.id': 8453,
    });
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('nests the requests of a transaction under its send span', async () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: traceTransport(mockTransport().transport),
    }).extend(withHashspan());

    await wallet.sendTransaction({ to: TO });
    const send = tracing.spanNamed('send 8453');
    const sent = tracing.spanNamed('eth_sendTransaction');
    expect(sent.parentSpanContext?.spanId).toBe(send.spanContext().spanId);
  });

  it('records the error code of a failed request, not its message, and passes the error on', async () => {
    const failure = new InvalidParamsRpcError(new Error('secret detail'));
    const transport = traceTransport(
      custom(
        {
          request: async () => {
            throw failure;
          },
        },
        { retryCount: 0 },
      ),
    );
    const client = createPublicClient({ chain: base, transport });

    await expect(client.request({ method: 'eth_chainId' })).rejects.toMatchObject({
      code: -32602,
    });
    const [span] = rpcSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBeUndefined();
    expect(span?.attributes['rpc.response.status_code']).toBe('-32602');
    expect(span?.attributes['error.type']).toBe('-32602');
    expect(JSON.stringify(span?.attributes)).not.toContain('secret');
  });

  it('records the class name of an error without a code', async () => {
    class ProviderDown extends Error {
      override name = 'ProviderDown';
    }
    const down = new ProviderDown('down');
    // A transport whose request fails as is: viem's custom() would wrap the error into one with a code.
    const failing: Transport = (params) => ({
      ...custom({ request: async () => '0x0' })(params),
      request: async () => {
        throw down;
      },
    });
    const { request } = traceTransport(failing)({ chain: base });

    await expect(request({ method: 'eth_chainId' })).rejects.toBe(down);
    expect(rpcSpans()[0]?.attributes['error.type']).toBe('ProviderDown');
    expect(rpcSpans()[0]?.attributes['rpc.response.status_code']).toBeUndefined();
  });

  it.each([
    ['https://user:pass@rpc.example.org/v2/secret-key?token=x', 'rpc.example.org', 443],
    ['http://127.0.0.1:8545', '127.0.0.1', 8545],
    ['wss://RPC.Example.org:8443/ws/secret-key', 'rpc.example.org', 8443],
    ['http://[::1]:8545/', '[::1]', 8545],
  ])('records only the host and port of %s', async (url, address, port) => {
    // A transport that exposes its URL the way viem's http and webSocket transports do.
    const withUrl: Transport = (params) => ({
      ...custom({ request: async () => '0x2105' })(params),
      value: { url },
    });
    const client = createPublicClient({ chain: base, transport: traceTransport(withUrl) });

    await client.getChainId();
    const attributes = rpcSpans()[0]?.attributes;
    expect(attributes?.['server.address']).toBe(address);
    expect(attributes?.['server.port']).toBe(port);
    expect(JSON.stringify(attributes)).not.toContain('secret');
  });

  it('runs the request with its span active, so HTTP spans nest under it', async () => {
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(
        custom({
          request: async () => {
            trace.getTracer('http').startSpan('POST').end();
            return '0x2105';
          },
        }),
      ),
    });

    await client.getChainId();
    expect(tracing.spanNamed('POST').parentSpanContext?.spanId).toBe(
      tracing.spanNamed('eth_chainId').spanContext().spanId,
    );
  });

  it('skips the methods the filter leaves out, and a method name that is not one', async () => {
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(mockTransport().transport, {
        methods: (method) => method !== 'eth_blockNumber',
      }),
    });
    await client.getBlockNumber();
    await client.getChainId();
    await client.request({ method: 'not a method' as never }).catch(() => {});
    expect(rpcSpans().map((s) => s.name)).toEqual(['eth_chainId', '_OTHER']);
  });

  it('sends untraced when the filter throws', async () => {
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(mockTransport().transport, {
        methods: () => {
          throw new Error('filter');
        },
      }),
    });
    expect(await client.getBlockNumber()).toBe(0x7bn);
    expect(rpcSpans()).toHaveLength(0);
  });

  it('returns the transport untouched when its request cannot be traced', async () => {
    const provider = trace.getTracerProvider();
    const broken = {
      getTracer: () => {
        throw new Error('no tracer');
      },
    };
    const client = createPublicClient({
      chain: base,
      transport: traceTransport(mockTransport().transport, { tracerProvider: broken as never }),
    });
    expect(await client.getBlockNumber()).toBe(0x7bn);
    expect(trace.getTracerProvider()).toBe(provider);
    expect(rpcSpans()).toHaveLength(0);
  });
});
