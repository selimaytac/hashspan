import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, custom, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { freePort } from './free-port.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const ZERO_HASH = `0x${'00'.repeat(32)}`;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

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
  await tracing.teardown();
});

/**
 * Anvil behind a flashblocks-like node: the first receipt of each transaction is a preconfirmation, with a zero block
 * hash and the L1 fee of another transaction.
 */
function flashblocksTransport() {
  const upstream = http(RPC_URL)({ chain: anvil });
  const preconfirmed = new Set<string>();
  let receiptRequests = 0;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const result = await upstream.request({ method, params } as never);
      if (method !== 'eth_getTransactionReceipt' || result === null) return result;
      receiptRequests++;
      const hash = String((params as unknown[])[0]);
      if (preconfirmed.has(hash)) return result;
      preconfirmed.add(hash);
      return { ...(result as object), blockHash: ZERO_HASH, l1Fee: '0x2c8655ad1' };
    },
  });
  return { transport, receiptRequests: () => receiptRequests };
}

describe('on Anvil behind a node that preconfirms receipts', () => {
  it('records the fees of the sealed receipt, not those of the preconfirmation', async () => {
    const node = flashblocksTransport();
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const reader = createPublicClient({
      chain: anvil,
      transport: node.transport,
      pollingInterval: 50,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1_000n });
    const preconfirmation = await reader.waitForTransactionReceipt({ hash });
    expect(preconfirmation.blockHash).toBe(ZERO_HASH);
    await expect(hashspan.flush()).resolves.toBe(true);

    const sealed = await createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
    }).getTransactionReceipt({ hash });
    const confirm = tracing.spanNamed('confirm 31337');
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(sealed.blockNumber),
      'blockchain.tx.fee': (sealed.gasUsed * sealed.effectiveGasPrice).toString(),
    });
    // Anvil is not an OP-stack chain: the sealed receipt has no L1 fee, the preconfirmation's was made up.
    expect(confirm.attributes).not.toHaveProperty('blockchain.tx.l1_fee');
    expect(node.receiptRequests()).toBeGreaterThanOrEqual(2);
  });
});
