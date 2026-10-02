import { Instance } from 'prool';
import { type Address, createWalletClient, custom, type Hex, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18592;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const OTHER = '0x00000000000000000000000000000000000000cd' as const;
/** Anvil's public default mnemonic; its first accounts are funded on every Anvil chain. */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
// A local account that signs in-process, the second one, so that the first stays free for the stand-in wallet.
const LOCAL_ACCOUNT = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

let tracing: TestTracing;
let unlocked: Address;

beforeAll(async () => {
  await instance.start();
  [unlocked] = (await createWalletClient({
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
  await tracing.teardown();
});

const sends = () => tracing.spans().filter((s) => s.name === 'send 31337');
const confirms = () => tracing.spans().filter((s) => s.name === 'confirm 31337');

/**
 * A stand-in EIP-5792 wallet in front of Anvil, which has no `wallet_*` methods: it sends a batch's first call as one
 * transaction from the unlocked account and reports that transaction's receipt as the batch status.
 */
function standInWallet() {
  const upstream = http(RPC_URL)({ chain: anvil });
  const batches = new Map<string, Hex>();
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === 'wallet_sendCalls') {
        const [{ calls, from }] = params as [{ calls: { to: Hex; value?: Hex }[]; from: Hex }];
        const hash = (await upstream.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: calls[0]?.to, value: calls[0]?.value }],
        } as never)) as Hex;
        const id = `batch-${batches.size + 1}`;
        batches.set(id, hash);
        return { id };
      }
      if (method === 'wallet_getCallsStatus') {
        const id = String((params as unknown[])[0]);
        const receipt = await upstream.request({
          method: 'eth_getTransactionReceipt',
          params: [batches.get(id)],
        } as never);
        return {
          version: '2.0.0',
          id,
          chainId: '0x7a69',
          atomic: true,
          status: receipt ? 200 : 100,
          receipts: receipt ? [receipt] : [],
        };
      }
      return upstream.request({ method, params } as never);
    },
  });
}

describe('call batches on Anvil', () => {
  it("traces viem's fallback as a batch whose transactions are confirmed as transactions", async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account: LOCAL_ACCOUNT,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    const status = await wallet.sendCallsSync({
      calls: [
        { to: RECIPIENT, value: 1n },
        { to: OTHER, value: 2n },
      ],
      experimental_fallback: true,
    });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(status.status).toBe('success');
    const hashes = status.receipts?.map((receipt) => receipt.transactionHash);
    expect(hashes).toHaveLength(2);
    const [send] = sends();
    expect(send?.attributes['blockchain.call_batch.call_count']).toBe(2);

    const batch = confirms().find((s) => s.attributes['blockchain.call_batch.id'] !== undefined);
    expect(batch?.attributes).toMatchObject({
      'blockchain.call_batch.status_code': 200,
      'blockchain.call_batch.transaction_hashes': hashes,
    });
    expect(batch?.attributes).not.toHaveProperty('blockchain.tx.fee');
    // Each transaction has its own confirm span with its fee, linked to the batch's send span.
    const transactions = confirms().filter((s) => s.attributes['blockchain.tx.hash'] !== undefined);
    expect(transactions.map((s) => s.attributes['blockchain.tx.hash']).sort()).toEqual(
      [...(hashes ?? [])].sort(),
    );
    for (const span of transactions) {
      expect(span.attributes['blockchain.tx.fee']).toBeDefined();
      expect(span.links[0]?.context.spanId).toBe(send?.spanContext().spanId);
    }
  });

  it('traces a batch a wallet answers, from wallet_sendCalls to its status', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({
      account: unlocked,
      chain: anvil,
      transport: standInWallet(),
      pollingInterval: 50,
    }).extend(hashspan);

    const { id } = await wallet.sendCalls({ calls: [{ to: RECIPIENT, value: 3n }] });
    const status = await wallet.waitForCallsStatus({ id });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(status.status).toBe('success');
    const [send] = sends();
    const [confirm] = confirms();
    expect(send?.attributes['blockchain.call_batch.id']).toBe(id);
    expect(confirm?.links[0]?.context.spanId).toBe(send?.spanContext().spanId);
    expect(confirm?.attributes).toMatchObject({
      'blockchain.call_batch.id': id,
      'blockchain.call_batch.status_code': 200,
      'blockchain.call_batch.atomic': true,
      'blockchain.call_batch.transaction_hashes': [status.receipts?.[0]?.transactionHash],
    });
  });
});
