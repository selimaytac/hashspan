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
const receiptCalls = (calls: string[]) =>
  calls.filter((method) => method === 'eth_getTransactionReceipt').length;

const ZERO_HASH = `0x${'00'.repeat(32)}`;
// A flashblocks node can report the L1 fee of another transaction before the block is sealed.
const PRECONFIRMED = { blockHash: ZERO_HASH, l1Fee: '0x1388' };
const SEALED_L1_FEE = '10000';
const SEALED_FEE = (21_000n * 1_000_000_000n + 10_000n).toString();

/** A node that returns `preconfirmedCalls` preconfirmed receipts before the sealed one. */
function flashblocksNode(
  preconfirmedCalls: number,
  preconfirmed: Record<string, unknown> = PRECONFIRMED,
) {
  return mockTransport({
    receipt: { l1Fee: '0x2710' },
    receiptAt: (call) => (call <= preconfirmedCalls ? preconfirmed : {}),
  });
}

describe('a preconfirmed receipt', () => {
  it("is returned to the caller unchanged, while the span records the sealed receipt's fees", async () => {
    const node = flashblocksNode(1);
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    }).extend(hashspan);

    const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
    expect(receipt.blockHash).toBe(ZERO_HASH);
    expect(receipt.l1Fee).toBe(5_000n);
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.l1_fee': SEALED_L1_FEE,
      'blockchain.tx.fee': SEALED_FEE,
    });
  });

  it('is replaced by the sealed receipt in watch(), however many preconfirmations come first', async () => {
    const node = flashblocksNode(3);
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirms()[0]?.attributes).toMatchObject({
      'blockchain.tx.l1_fee': SEALED_L1_FEE,
      'blockchain.tx.fee': SEALED_FEE,
    });
    expect(receiptCalls(node.calls)).toBe(4);
  });

  it('is recognised by a null block hash as well', async () => {
    const node = flashblocksNode(1, { ...PRECONFIRMED, blockHash: null });
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirms()[0]?.attributes['blockchain.tx.l1_fee']).toBe(SEALED_L1_FEE);
  });

  it('is recorded with the revert reason and the sealed fees when the transaction reverted', async () => {
    const vault = parseAbi(['error Blocked(uint256 code)']);
    const node = mockTransport({
      receipt: { l1Fee: '0x2710', status: '0x0' },
      receiptAt: (call) => (call === 1 ? PRECONFIRMED : {}),
      callRevertData: encodeErrorResult({ abi: vault, errorName: 'Blocked', args: [7n] }),
    });
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH, abi: vault });
    await expect(hashspan.flush()).resolves.toBe(true);

    const [confirm] = confirms();
    expect(confirm?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm?.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'blockchain.tx.revert.reason': 'Blocked(7)',
      'blockchain.tx.l1_fee': SEALED_L1_FEE,
      'blockchain.tx.fee': SEALED_FEE,
    });
  });

  it('is recorded without fees when no sealed receipt comes in time', async () => {
    const node = mockTransport({ receipt: PRECONFIRMED });
    const warn = vi.fn();
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });
    vi.spyOn(diag, 'warn').mockImplementation(warn);

    hashspan.watch(reader, { hash: HASH, timeoutMs: 100 });
    await expect(hashspan.flush()).resolves.toBe(true);

    const attributes = confirms()[0]?.attributes ?? {};
    expect(attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 123,
      'blockchain.tx.gas.used': 21_000,
    });
    expect(attributes).not.toHaveProperty('blockchain.tx.l1_fee');
    expect(attributes).not.toHaveProperty('blockchain.tx.fee');
    expect(attributes).not.toHaveProperty('blockchain.tx.effective_gas_price');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without fees'));
    expect(receiptCalls(node.calls)).toBeGreaterThan(2);
  });

  it('is recorded without fees, not as a timeout, by a flush that cannot wait for the sealed one', async () => {
    const node = mockTransport({ receipt: PRECONFIRMED });
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    }).extend(hashspan);

    await reader.waitForTransactionReceipt({ hash: HASH });
    await expect(hashspan.flush({ timeoutMs: 50 })).resolves.toBe(false);

    const [confirm] = confirms();
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
    expect(confirm?.attributes).not.toHaveProperty('blockchain.tx.l1_fee');
    expect(confirm?.attributes).not.toHaveProperty('blockchain.tx.fee');
  });

  it('is told apart from a sealed receipt, which is recorded without another request', async () => {
    const node = mockTransport({ receipt: { l1Fee: '0x2710' } });
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirms()[0]?.attributes['blockchain.tx.l1_fee']).toBe(SEALED_L1_FEE);
    expect(receiptCalls(node.calls)).toBe(1);
  });
});
