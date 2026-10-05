import { createTxTracker } from '@hashspan/core';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, encodeErrorResult, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const confirms = () => tracing.spans().filter((s) => s.name === 'confirm 8453');
const vault = parseAbi(['error Blocked(uint256 code)']);

describe('watch', () => {
  it('confirms a transaction sent elsewhere, in the background', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    });

    expect(hashspan.watch(reader, { hash: HASH })).toBeUndefined();
    await expect(hashspan.flush()).resolves.toBe(true);

    const [confirm] = confirms();
    expect(confirm?.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
    });
  });

  it('records nothing and warns when the chain id contradicts the client', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const hashspan = withHashspan();
    const mock = mockTransport();
    const reader = createPublicClient({
      chain: base,
      transport: mock.transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH, chainId: 1 });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(tracing.spans()).toHaveLength(0);
    expect(mock.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: watch() got chain 1 and a client on chain 8453; not recording it',
    );
  });

  it('uses an explicit chain id with a client without a chain', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      transport: mockTransport().transport,
      pollingInterval: 10,
    });
    hashspan.watch(reader, { hash: HASH, chainId: 8453 });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('links to a send span recorded by the same tracker', async () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: 8453 }).end({ hash: HASH });
    const hashspan = withHashspan({ tracker });
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH });
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    expect(confirms()[0]?.links[0]?.context.spanId).toBe(send.spanContext().spanId);
  });

  it('uses the chain id it is given for a client without a chain', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      transport: mockTransport().transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH, chainId: 8453 });
    await hashspan.flush();
    expect(confirms()).toHaveLength(1);
  });

  it('records nothing, and does not throw, when the chain id is unknown', async () => {
    const debug = vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const hashspan = withHashspan();
    const reader = createPublicClient({
      transport: mockTransport().transport,
      pollingInterval: 10,
    });

    expect(() => hashspan.watch(reader, { hash: HASH })).not.toThrow();
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spans()).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('chain id'));
  });

  it('decodes the revert reason with the ABI it is given', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({
        receipt: { status: '0x0' },
        callRevertData: encodeErrorResult({ abi: vault, errorName: 'Blocked', args: [7n] }),
      }).transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH, abi: vault });
    await hashspan.flush();

    const [confirm] = confirms();
    expect(confirm?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm?.attributes['blockchain.tx.revert.reason']).toBe('Blocked(7)');
  });

  it('ends as timeout when no receipt arrives within timeoutMs', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH, timeoutMs: 50 });
    await hashspan.flush();
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirms()[0]?.attributes['error.type']).toBe('timeout');
  });

  it('records one confirm span when a transaction is watched twice', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH });
    hashspan.watch(reader, { hash: HASH });
    await hashspan.flush();
    expect(confirms()).toHaveLength(1);
  });

  it.each([
    ['a bigint', 1n],
    ['a symbol', Symbol('ms')],
    ['an array', [50]],
    ['a string', '50'],
    ['NaN', Number.NaN],
    ['a negative number', -1],
  ])('confirms with the default timeout when timeoutMs is %s', async (_label, timeoutMs) => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    });

    expect(() =>
      hashspan.watch(reader, { hash: HASH, timeoutMs: timeoutMs as never }),
    ).not.toThrow();
    await expect(hashspan.flush({ timeoutMs: 1_000 })).resolves.toBe(true);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('never throws for a decodeRevertReason option it cannot read', () => {
    const unreadable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    expect(() => withHashspan({ decodeRevertReason: unreadable as never })).not.toThrow();
  });
});
