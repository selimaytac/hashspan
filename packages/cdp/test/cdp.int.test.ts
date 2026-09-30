import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startMockCdpApi, throwawayCredentials } from './mock-cdp-api.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18561;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;

// Keep the SDK's own usage tracking and error reporting off: tests make no request outside localhost.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';

// Anvil with Base Sepolia's chain id, so the real CDP network name applies.
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: 84532,
});

let api: Awaited<ReturnType<typeof startMockCdpApi>>;
let tracing: TestTracing;
/** Every URL requested through fetch, which the SDK uses for its analytics. */
const fetched: string[] = [];

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    // Blocked rather than passed on, so that a misconfiguration cannot send anything out either.
    if (!url.startsWith('http://127.0.0.1'))
      return Promise.resolve(new Response(null, { status: 204 }));
    return realFetch(input, init);
  });
  await instance.start();
  const [account] = (await createWalletClient({ transport: http(RPC_URL) }).getAddresses()) as [
    Address,
  ];
  api = await startMockCdpApi({ rpcUrl: RPC_URL, account });
});
afterAll(async () => {
  await api.close();
  await instance.stop();
  vi.restoreAllMocks();
  // Nothing left localhost: no analytics, no error reports, no public RPC.
  expect(fetched.filter((url) => !url.startsWith('http://127.0.0.1'))).toEqual([]);
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const client = async () => {
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient({ ...throwawayCredentials(), basePath: api.basePath });
  const reader = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
    pollingInterval: 50,
  });
  return { cdp, hashspan: withHashspan(cdp as never, { reader }) };
};

describe('the CDP SDK against a local CDP API and Anvil', () => {
  it('traces an account sendTransaction from send to confirmation', async () => {
    const { cdp, hashspan } = await client();
    const account = await cdp.evm.createAccount();
    const { transactionHash } = await account.sendTransaction({
      network: 'base-sepolia',
      transaction: { to: RECIPIENT, value: 1n },
    });
    await expect(hashspan.flush()).resolves.toBe(true);

    const send = tracing.spanNamed('send 84532');
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': transactionHash,
      'blockchain.tx.from': account.address,
      'blockchain.tx.to': RECIPIENT,
      'blockchain.tx.value': '1',
    });
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
    });
  });

  it('traces cdp.evm.sendTransaction and an ETH transfer', async () => {
    const { cdp, hashspan } = await client();
    const account = await cdp.evm.createAccount();
    const sendsBefore = api.requests.filter((r) => r.endsWith('/send/transaction')).length;
    await cdp.evm.sendTransaction({
      address: account.address,
      network: 'base-sepolia',
      transaction: { to: RECIPIENT, value: 2n },
    });
    await account.transfer({ to: RECIPIENT, amount: 3n, token: 'eth', network: 'base-sepolia' });
    await hashspan.flush();

    const values = tracing
      .spans()
      .filter((s) => s.name === 'send 84532')
      .map((s) => s.attributes['blockchain.tx.value']);
    expect(values.sort()).toEqual(['2', '3']);
    expect(tracing.spans().filter((s) => s.name === 'confirm 84532')).toHaveLength(2);
    expect(api.requests.filter((r) => r.endsWith('/send/transaction')).length - sendsBefore).toBe(
      2,
    );
  });
});
