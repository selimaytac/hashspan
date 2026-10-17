import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseGwei,
} from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const LOW_FEE = { maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') };
const HIGH_FEE = { maxFeePerGas: parseGwei('20'), maxPriorityFeePerGas: parseGwei('10') };

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

let tracing: TestTracing;
let account: Address;

const reader = () =>
  createPublicClient({ chain: anvil, transport: http(RPC_URL), pollingInterval: 50 });
const rpc = (method: string, params: unknown[] = []) =>
  reader().request({ method: method as never, params: params as never });
const confirmOf = (hash: string) =>
  tracing
    .spans()
    .filter((s) => s.name === 'confirm 31337' && s.attributes['blockchain.tx.hash'] === hash);

beforeAll(async () => {
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(async () => {
  tracing = setupTracing();
  await rpc('evm_setAutomine', [false]);
});
afterEach(async () => {
  await rpc('evm_setAutomine', [true]);
  await tracing.teardown();
});

// viem detects a replacement only after it has read the original transaction once, for its sender and nonce. A
// replacement that takes the original out of the node's pool before that is never detected: viem's wait times out.
describe('a transaction replaced before the wait read it', () => {
  it('ends the confirm span of a cancelled transaction as replaced', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const client = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    const nonce = await reader().getTransactionCount({ address: account, blockTag: 'pending' });
    const original = await wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce, ...LOW_FEE });
    const cancel = await wallet.sendTransaction({ to: account, value: 0n, nonce, ...HIGH_FEE });
    await rpc('evm_mine');

    // The caller's result is viem's: a timeout.
    await expect(
      client.waitForTransactionReceipt({ hash: original, timeout: 1_500, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await hashspan.flush();

    const [originalConfirm] = confirmOf(original);
    expect(originalConfirm?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': cancel,
    });
    expect(originalConfirm?.attributes['error.type']).toBeUndefined();
    // hashspan found the replacement, not viem: it infers no reason.
    expect(originalConfirm?.attributes['blockchain.tx.replacement.reason']).toBeUndefined();
    expect(confirmOf(cancel)[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('ends it as replaced when the cancel is sent right after the wait started', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const client = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    const nonce = await reader().getTransactionCount({ address: account, blockTag: 'pending' });
    const original = await wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce, ...LOW_FEE });
    const wait = client
      .waitForTransactionReceipt({ hash: original, timeout: 1_500, retryDelay: 1 })
      .then(
        (receipt) => receipt.transactionHash,
        (error: Error) => error.name,
      );
    const cancel = await wallet.sendTransaction({ to: account, value: 0n, nonce, ...HIGH_FEE });
    await rpc('evm_mine');
    // Whether viem read the original before the cancel took it out of the pool decides what the caller gets: the
    // cancel's receipt and a reason, or viem's timeout and none. The span is replaced either way.
    const result = await wait;
    await hashspan.flush();

    expect(confirmOf(original)[0]?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': cancel,
    });
    expect(confirmOf(original)[0]?.attributes['blockchain.tx.replacement.reason']).toBe(
      result === cancel ? 'cancelled' : undefined,
    );
    expect(confirmOf(cancel)[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('ends a background confirmation as replaced', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 1_500 } });
    // Holds viem's read of the original until the cancel is mined, so the cancel takes it out of the pool first.
    const upstream = http(RPC_URL)({ chain: anvil });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_getTransactionByHash') await released;
        return upstream.request({ method, params } as never);
      },
    });
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport,
      pollingInterval: 50,
    }).extend(hashspan);

    const nonce = await reader().getTransactionCount({ address: account, blockTag: 'pending' });
    const original = await wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce, ...LOW_FEE });
    const cancel = await wallet.sendTransaction({ to: account, value: 0n, nonce, ...HIGH_FEE });
    await rpc('evm_mine');
    release();
    expect(await hashspan.flush({ timeoutMs: 10_000 })).toBe(true);

    expect(confirmOf(original)[0]?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': cancel,
    });
    expect(confirmOf(cancel)).toHaveLength(1);
    expect(confirmOf(cancel)[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('stays a timeout when the original send passed no nonce', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const client = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    const nonce = await reader().getTransactionCount({ address: account, blockTag: 'pending' });
    const original = await wallet.sendTransaction({ to: RECIPIENT, value: 1n, ...LOW_FEE });
    await wallet.sendTransaction({ to: account, value: 0n, nonce, ...HIGH_FEE });
    await rpc('evm_mine');

    await expect(
      client.waitForTransactionReceipt({ hash: original, timeout: 1_500, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await hashspan.flush();

    expect(confirmOf(original)[0]?.attributes['error.type']).toBe('timeout');
    expect(confirmOf(original)[0]?.attributes['blockchain.tx.status']).toBeUndefined();
  });
});
