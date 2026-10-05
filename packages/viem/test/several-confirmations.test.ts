// A wait with `confirmations` above 1: once it resolved, the confirm span reads the receipt again and records what
// the chain holds (docs/adr/0026-receipt-after-several-confirmations.md). Chain reorganisations on a real node are in
// reorg.int.test.ts, RPC faults on the check in rpc-faults.int.test.ts.
import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import { createPublicClient, custom, RpcRequestError } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** The block hash of the mock's receipt: the block the caller's wait read it in. */
const CALLER_BLOCK = `0x${'cd'.repeat(32)}`;
const OTHER_BLOCK = `0x${'ef'.repeat(32)}`;
const NEW_BLOCK_AT_HEIGHT = `0x${'99'.repeat(32)}`;
const MOVED = { blockHash: OTHER_BLOCK, blockNumber: '0x7a', gasUsed: '0x6000' };

type Answer = Record<string, unknown> | null | 'fail' | 'hang';

const failure = (method: string) =>
  new RpcRequestError({
    body: {},
    error: { code: -32602, message: `mock: ${method}` },
    url: 'mock',
  });

/**
 * A node whose first receipt is the mock's (block 0x7b, hash `CALLER_BLOCK`) and whose block number advances on every
 * poll, so a wait for 2 confirmations resolves on the second poll. `reread` answers every later receipt request, with
 * fields merged into the mock's receipt; `block` answers `eth_getBlockByNumber`, with fields merged into the mock's
 * block (`null`: no block at that height).
 */
function node(options: { reread?: Answer; block?: Answer; blockDelayMs?: number } = {}) {
  const mock = mockTransport({ advanceBlocks: true });
  const inner = mock.transport({ chain: base, retryCount: 0 });
  const calls: string[] = [];
  let receipts = 0;
  const answer = async (method: string, params: unknown, given: Answer | undefined) => {
    if (given === undefined) return inner.request({ method, params } as never);
    if (given === 'fail') throw failure(method);
    if (given === 'hang') return new Promise(() => {});
    if (given === null) return null;
    return { ...((await inner.request({ method, params } as never)) as object), ...given };
  };
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      if (method === 'eth_getTransactionReceipt' && ++receipts > 1) {
        return answer(method, params, options.reread);
      }
      if (method === 'eth_getBlockByNumber') {
        if (options.blockDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.blockDelayMs));
        }
        return answer(method, params, options.block);
      }
      return inner.request({ method, params } as never);
    },
  });
  return {
    transport,
    count: (method: string) => calls.filter((called) => called === method).length,
  };
}

/** A meter provider that keeps what the confirmation duration histogram records. */
function recordingMeterProvider() {
  const recorded: Attributes[] = [];
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => ({
        record: (_value: number, attributes: Attributes = {}) => {
          if (name === 'blockchain.client.confirmation.duration') recorded.push(attributes);
        },
      }),
    }),
  } as unknown as MeterProvider;
  return { provider, recorded };
}

/** Waits for 2 confirmations through `chain` on a traced client and flushes. */
async function waitFor2(
  chain: ReturnType<typeof node>,
  extra: { timeout?: number; flushTimeoutMs?: number; confirmations?: number } = {},
) {
  const meters = recordingMeterProvider();
  const hashspan = withHashspan({ meterProvider: meters.provider });
  const reader = createPublicClient({
    chain: base,
    transport: chain.transport,
    pollingInterval: 10,
  }).extend(hashspan);
  const receipt = await reader.waitForTransactionReceipt({
    hash: HASH,
    confirmations: extra.confirmations ?? 2,
    ...(extra.timeout === undefined ? {} : { timeout: extra.timeout }),
  });
  const returnedAt = Date.now();
  const flushed = await hashspan.flush({ timeoutMs: extra.flushTimeoutMs ?? 5_000 });
  const [span, ...others] = tracing.spans().filter((s) => s.name === 'confirm 8453');
  expect(others).toEqual([]);
  if (!span) throw new Error('no confirm span');
  return { receipt, returnedAt, flushed, span, metrics: meters.recorded };
}

/** The confirm span recorded the caller's receipt: block 123, success. */
function expectCallerReceipt(attributes: Attributes) {
  expect(attributes).toMatchObject({
    'blockchain.tx.status': 'success',
    'blockchain.block.number': 123,
    'blockchain.tx.gas.used': 21_000,
  });
  expect(attributes['error.type']).toBeUndefined();
}

describe('a wait for several confirmations', () => {
  it('records the receipt read again when it is in the same block, without reading the block', async () => {
    const chain = node();
    const { receipt, flushed, span } = await waitFor2(chain);

    expect(receipt.blockNumber).toBe(123n);
    expect(flushed).toBe(true);
    expectCallerReceipt(span.attributes);
    expect(chain.count('eth_getTransactionReceipt')).toBe(2);
    expect(chain.count('eth_getBlockByNumber')).toBe(0);
  });

  it('records the receipt in another block when the block at the height has another hash', async () => {
    const chain = node({ reread: MOVED, block: { hash: NEW_BLOCK_AT_HEIGHT } });
    const { receipt, span, metrics } = await waitFor2(chain);

    // The caller's result is what viem returned.
    expect(receipt).toMatchObject({ blockNumber: 123n, blockHash: CALLER_BLOCK, gasUsed: 21_000n });
    expect(span.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 122,
      'blockchain.tx.gas.used': 0x6000,
    });
    expect(metrics).toEqual([expect.objectContaining({ 'blockchain.tx.status': 'success' })]);
  });

  it('records the status of the receipt in another block', async () => {
    const chain = node({
      reread: { ...MOVED, status: '0x0' },
      block: { hash: NEW_BLOCK_AT_HEIGHT },
    });
    const { receipt, span } = await waitFor2(chain);

    expect(receipt.status).toBe('success');
    expect(span.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'blockchain.block.number': 122,
      'error.type': 'reverted',
    });
  });

  it('ends as not_on_chain, without a status, when no receipt is left and the block was replaced', async () => {
    const chain = node({ reread: null, block: { hash: NEW_BLOCK_AT_HEIGHT } });
    const { receipt, returnedAt, flushed, span, metrics } = await waitFor2(chain);

    expect(receipt).toMatchObject({ transactionHash: HASH, blockNumber: 123n });
    expect(flushed).toBe(true);
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.attributes['error.type']).toBe('not_on_chain');
    expect(span.attributes['blockchain.tx.status']).toBeUndefined();
    expect(span.attributes['blockchain.block.number']).toBeUndefined();
    expect(span.events).toEqual([]);
    expect(metrics).toEqual([expect.objectContaining({ 'error.type': 'not_on_chain' })]);
    expect(metrics[0]?.['blockchain.tx.status']).toBeUndefined();
    const [seconds, nanos] = span.endTime;
    expect(seconds * 1_000 + nanos / 1e6).toBeLessThanOrEqual(returnedAt + 5);
  });

  it.each([
    ['the node has no block at the height', { reread: null, block: null }],
    ["the block at the height still has the caller's hash", { reread: null }],
    ["the block still has the caller's hash, the receipt read again another", { reread: MOVED }],
    ['the receipt request fails', { reread: 'fail' }],
    ['the block request fails', { reread: null, block: 'fail' }],
    ['the receipt read again is malformed', { reread: { blockNumber: '0xzz' } }],
    [
      'the receipt read again is of another transaction',
      { reread: { transactionHash: `0x${'12'.repeat(32)}` } },
    ],
    ['the receipt read again has no block hash', { reread: { blockHash: null } }],
    [
      'the receipt read again is a preconfirmation',
      { reread: { blockHash: `0x${'00'.repeat(32)}` } },
    ],
    ['the block has no hash', { reread: null, block: { hash: null } }],
  ] as const)("records the caller's receipt when %s", async (_case, answers) => {
    const chain = node(answers as { reread?: Answer; block?: Answer });
    const { flushed, span } = await waitFor2(chain);

    expect(flushed).toBe(true);
    expectCallerReceipt(span.attributes);
  });

  it('ends at the time the wait resolved, not when the check finished', async () => {
    const chain = node({ reread: null, blockDelayMs: 200 });
    const { returnedAt, span } = await waitFor2(chain);

    expectCallerReceipt(span.attributes);
    const [seconds, nanos] = span.endTime;
    expect(seconds * 1_000 + nanos / 1e6).toBeLessThanOrEqual(returnedAt + 5);
  });

  it("records the caller's receipt when the check outlasts the wait's timeout", async () => {
    const chain = node({ reread: null, block: 'hang' });
    const { flushed, span } = await waitFor2(chain, { timeout: 300 });

    expect(flushed).toBe(true);
    expectCallerReceipt(span.attributes);
  });

  it("records the caller's receipt when flush() cannot wait for the check", async () => {
    const chain = node({ reread: 'hang' });
    const { flushed, span } = await waitFor2(chain, { flushTimeoutMs: 100 });

    expect(flushed).toBe(false);
    expectCallerReceipt(span.attributes);
  });

  it('checks the wait of a client without a chain, once its chain id is known', async () => {
    const chain = node({ reread: null, block: { hash: NEW_BLOCK_AT_HEIGHT } });
    const hashspan = withHashspan();
    // No chain: the chain id comes from eth_chainId (0x2105) after the wait started.
    const reader = createPublicClient({ transport: chain.transport, pollingInterval: 10 }).extend(
      hashspan,
    );

    const receipt = await reader.waitForTransactionReceipt({ hash: HASH, confirmations: 2 });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(receipt.blockNumber).toBe(123n);
    const [span] = tracing.spans().filter((s) => s.name === 'confirm 8453');
    expect(span?.attributes['error.type']).toBe('not_on_chain');
    expect(span?.attributes['blockchain.tx.status']).toBeUndefined();
  });

  it('reads nothing again for a wait for one confirmation', async () => {
    const chain = node({ reread: null, block: { hash: NEW_BLOCK_AT_HEIGHT } });
    const { span } = await waitFor2(chain, { confirmations: 1 });

    expectCallerReceipt(span.attributes);
    expect(chain.count('eth_getTransactionReceipt')).toBe(1);
    expect(chain.count('eth_getBlockByNumber')).toBe(0);
  });

  it('does not check a preconfirmed receipt, whose sealed receipt is read instead', async () => {
    const mock = mockTransport({
      advanceBlocks: true,
      receiptAt: (call) => (call === 1 ? { blockHash: `0x${'00'.repeat(32)}` } : {}),
    });
    const calls: string[] = [];
    const chain = {
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          calls.push(method);
          return mock
            .transport({ chain: base, retryCount: 0 })
            .request({ method, params } as never);
        },
      }),
      count: (method: string) => calls.filter((called) => called === method).length,
    };
    const { span } = await waitFor2(chain);

    expectCallerReceipt(span.attributes);
    expect(chain.count('eth_getTransactionReceipt')).toBe(2);
    expect(chain.count('eth_getBlockByNumber')).toBe(0);
  });

  it('does not read the receipt of a reported replacement again', async () => {
    const mined = `0x${'34'.repeat(32)}` as const;
    const replacing = {
      transactionHash: mined,
      blockHash: OTHER_BLOCK,
      status: 'success' as const,
      blockNumber: 124n,
      gasUsed: 21_000n,
      effectiveGasPrice: 2n,
    };
    const chain = node({ reread: null, block: { hash: NEW_BLOCK_AT_HEIGHT } });
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: base, transport: chain.transport })
      .extend(() => ({
        // Reports a replacement as viem does: onReplaced, then the replacing receipt.
        waitForTransactionReceipt: async (args: { onReplaced?: (r: unknown) => void }) => {
          args.onReplaced?.({
            reason: 'repriced',
            replacedTransaction: { hash: HASH, to: TO },
            transaction: { hash: mined, to: TO },
            transactionReceipt: replacing,
          });
          return replacing;
        },
      }))
      .extend(hashspan);

    await reader.waitForTransactionReceipt({ hash: HASH, confirmations: 2 });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(chain.count('eth_getTransactionReceipt')).toBe(0);
    expect(chain.count('eth_getBlockByNumber')).toBe(0);
    const replaced = tracing
      .spans()
      .find((s) => s.name === 'confirm 8453' && s.attributes['blockchain.tx.hash'] === HASH);
    expect(replaced?.attributes['blockchain.tx.status']).toBe('replaced');
  });
});
