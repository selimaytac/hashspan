// Chain reorganisations on Anvil (`anvil_reorg`, `anvil_rollback`): pins what confirm spans record today when a block
// that held a transaction is removed, after or during a wait. The behaviour is stated in docs/semconv.md (Spans,
// "Chain reorganisations"). `watch()` and background confirmation take no `confirmations` option: they end on the
// first receipt, so the cases with confirmations above 1 apply only to the caller's own wait.
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, custom, type Hex, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { freePort } from './free-port.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

/** Untraced client for chain control and checks, without viem's block number cache. */
const control = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
  cacheTime: 0,
  pollingInterval: 50,
});
const rpc = (method: string, params: unknown[] = []): Promise<unknown> =>
  control.request({ method: method as never, params: params as never });

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  await instance.start();
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await rpc('evm_setAutomine', [true]);
  await tracing.teardown();
});

const confirmSpans = () => tracing.spans().filter((s) => s.name === 'confirm 31337');

/** Whether the node still has a receipt for `hash`. */
const hasReceipt = (hash: Hex): Promise<boolean> =>
  control.getTransactionReceipt({ hash }).then(
    () => true,
    () => false,
  );

/**
 * A transport to Anvil that counts receipt responses and can hold every request at a gate, so a test can change the
 * chain between two polls of a client.
 */
function gatedTransport() {
  const upstream = http(RPC_URL)({ chain: anvil });
  let receipts = 0;
  let receiptRequests = 0;
  let inFlight = 0;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      while (gate) await gate;
      inFlight++;
      if (method === 'eth_getTransactionReceipt') receiptRequests++;
      try {
        const result = await upstream.request({ method, params } as never);
        if (method === 'eth_getTransactionReceipt' && result !== null) receipts++;
        return result;
      } finally {
        inFlight--;
      }
    },
  });
  return {
    transport,
    /** Receipts the node returned through this transport so far. */
    receipts: () => receipts,
    /** Receipt requests made through this transport so far, answered or not. */
    receiptRequests: () => receiptRequests,
    /** Holds new requests and resolves once none is in flight. */
    async close() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
      await vi.waitFor(() => expect(inFlight).toBe(0), { timeout: 5_000, interval: 5 });
    },
    open() {
      gate = undefined;
      open?.();
    },
  };
}

/** Sends a transfer through an untraced client and waits until it is mined. */
async function minedTransfer(): Promise<{ hash: Hex; blockNumber: bigint }> {
  const plain = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) });
  const hash = await plain.sendTransaction({ to: RECIPIENT, value: 1n });
  const { blockNumber } = await control.waitForTransactionReceipt({ hash });
  return { hash, blockNumber };
}

describe('a chain reorganisation after the confirm span ended', () => {
  it('keeps the receipt it recorded, and a later wait on the same tracker adds no span', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const reader = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    await rpc('anvil_reorg', [1, []]);
    expect(await hasReceipt(hash)).toBe(false);

    // The caller's retry finds no receipt; the tracker still treats the transaction as settled (ADR 0007).
    await expect(
      reader.waitForTransactionReceipt({ hash, timeout: 1_000, retryCount: 1, retryDelay: 10 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirmSpans()).toHaveLength(1);
    expect(confirmSpans()[0]?.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(receipt.blockNumber),
    });
    expect(confirmSpans()[0]?.attributes['error.type']).toBeUndefined();
  });

  it('keeps the receipt of a watch()', async () => {
    const hashspan = withHashspan();
    const { hash, blockNumber } = await minedTransfer();
    const onReceipt = vi.fn();
    hashspan.watch(control, { hash, timeoutMs: 5_000, onReceipt });
    await expect(hashspan.flush()).resolves.toBe(true);
    await rpc('anvil_reorg', [1, []]);
    expect(await hasReceipt(hash)).toBe(false);

    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash }));
    expect(confirmSpans()).toHaveLength(1);
    expect(confirmSpans()[0]?.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(blockNumber),
    });
  });

  it('keeps the receipt of a background confirmation', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 5_000 } });
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    await expect(hashspan.flush()).resolves.toBe(true);
    const blockNumber = confirmSpans()[0]?.attributes['blockchain.block.number'];
    await rpc('anvil_rollback', [1]);
    expect(await hasReceipt(hash)).toBe(false);

    expect(confirmSpans()).toHaveLength(1);
    expect(confirmSpans()[0]?.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': blockNumber,
    });
  });
});

describe('a chain reorganisation while a wait with confirmations above 1 runs', () => {
  /**
   * Starts a traced wait for 3 confirmations of a mined transfer and resolves once the wait has read its receipt.
   */
  async function waitingForConfirmations() {
    const hashspan = withHashspan();
    // An empty block first, so a reorganisation of depth 2 can move the transaction one block lower.
    await rpc('evm_mine');
    const { hash, blockNumber } = await minedTransfer();
    const gated = gatedTransport();
    const reader = createPublicClient({
      chain: anvil,
      transport: gated.transport,
      pollingInterval: 50,
    }).extend(hashspan);
    const wait = reader.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 10_000 });
    await vi.waitFor(() => expect(gated.receipts()).toBeGreaterThan(0), { timeout: 5_000 });
    return { hashspan, hash, blockNumber, wait };
  }

  it('ends with the receipt read before the reorganisation when the transaction moved to another block', async () => {
    const { hashspan, hash, blockNumber, wait } = await waitingForConfirmations();
    const raw = await rpc('eth_getRawTransactionByHash', [hash]);
    // Replaces the transaction's block and the one before it; the transaction is now in the lower one.
    await rpc('anvil_reorg', [2, [[raw, 0]]]);
    const moved = await control.getTransactionReceipt({ hash });
    expect(moved.blockNumber).toBe(blockNumber - 1n);
    await rpc('anvil_mine', ['0x2']);

    // viem resolves with the receipt it read first: same block number, but a block hash no longer on the chain.
    const receipt = await wait;
    expect(receipt.blockNumber).toBe(blockNumber);
    expect(receipt.blockHash).not.toBe(moved.blockHash);
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(confirmSpans()).toHaveLength(1);
    expect(confirmSpans()[0]?.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(blockNumber),
    });
  });

  // Defect #306: the span records success for a transaction the reorganisation removed, as the caller's wait
  // resolves with the receipt it read before. Changing that is a change of span semantics and needs an ADR.
  it('ends as success with the removed receipt when the transaction was dropped', async () => {
    const { hashspan, hash, blockNumber, wait } = await waitingForConfirmations();
    await rpc('anvil_reorg', [1, []]);
    expect(await hasReceipt(hash)).toBe(false);
    await rpc('anvil_mine', ['0x2']);

    await expect(wait).resolves.toMatchObject({ transactionHash: hash, blockNumber });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(await hasReceipt(hash)).toBe(false);

    expect(confirmSpans()).toHaveLength(1);
    expect(confirmSpans()[0]?.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(blockNumber),
    });
  });
});

describe('a transaction dropped by a reorganisation and not included again', () => {
  const expectTimedOut = (hash: Hex) => {
    expect(confirmSpans()).toHaveLength(1);
    const [span] = confirmSpans();
    expect(span?.attributes['blockchain.tx.hash']).toBe(hash);
    expect(span?.attributes['error.type']).toBe('timeout');
    expect(span?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(span?.attributes['blockchain.block.number']).toBeUndefined();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
  };

  it("ends the caller's wait as a timeout", async () => {
    const hashspan = withHashspan();
    const { hash } = await minedTransfer();
    await rpc('anvil_rollback', [1]);
    expect(await hasReceipt(hash)).toBe(false);
    const reader = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    await expect(
      reader.waitForTransactionReceipt({ hash, timeout: 1_000, retryCount: 1, retryDelay: 10 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await expect(hashspan.flush({ timeoutMs: 10_000 })).resolves.toBe(true);
    expectTimedOut(hash);
  });

  it('ends a watch() as a timeout and calls onReceipt without a receipt', async () => {
    const hashspan = withHashspan();
    const { hash } = await minedTransfer();
    await rpc('anvil_rollback', [1]);
    expect(await hasReceipt(hash)).toBe(false);
    const onReceipt = vi.fn();

    hashspan.watch(control, { hash, timeoutMs: 1_000, onReceipt });
    await expect(hashspan.flush({ timeoutMs: 10_000 })).resolves.toBe(true);
    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(undefined);
    expectTimedOut(hash);
  });

  it('ends a background confirmation that had not read the receipt as a timeout', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 2_000 } });
    const gated = gatedTransport();
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: gated.transport,
      pollingInterval: 50,
    }).extend(hashspan);

    await rpc('evm_setAutomine', [false]);
    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    // The background confirmation polls the pending transaction; hold its requests while the chain changes.
    await vi.waitFor(() => expect(gated.receiptRequests()).toBeGreaterThan(1), { timeout: 5_000 });
    await gated.close();
    const requestsBefore = gated.receiptRequests();
    await rpc('evm_mine');
    expect(await hasReceipt(hash)).toBe(true);
    await rpc('anvil_rollback', [1]);
    expect(await hasReceipt(hash)).toBe(false);
    // The chain moves on without the transaction.
    await rpc('anvil_mine', ['0x2']);
    gated.open();

    await expect(hashspan.flush({ timeoutMs: 10_000 })).resolves.toBe(true);
    // It polled again after the change, and the node never returned a receipt to it.
    expect(gated.receiptRequests()).toBeGreaterThan(requestsBefore);
    expect(gated.receipts()).toBe(0);
    expectTimedOut(hash);
  });
});
