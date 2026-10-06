import { SpanStatusCode } from '@opentelemetry/api';
import { type Address, createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAnvil } from '../../viem/test/start-anvil.js';
import { withHashspan } from '../src/index.js';
import { startMockCdpApi, throwawayCredentials } from './mock-cdp-api.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;

// Keep the SDK's own usage tracking and error reporting off: tests make no request outside localhost.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';

// Anvil with Base Sepolia's chain id, so the real CDP network name applies.
const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: 84532,
});

/** Untraced client for chain control and checks, without viem's block number cache. */
const control = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
  cacheTime: 0,
  pollingInterval: 50,
});
const rpc = (method: string, params: unknown[] = []): Promise<unknown> =>
  control.request({ method: method as never, params: params as never });

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

const client = async (options: { reader?: boolean } = {}) => {
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient({ ...throwawayCredentials(), basePath: api.basePath });
  const reader = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
    pollingInterval: 50,
  });
  return {
    cdp,
    hashspan: withHashspan(cdp, options.reader === false ? {} : { reader }),
  };
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
      'blockchain.tx.from': account.address.toLowerCase(),
      'blockchain.tx.to': RECIPIENT.toLowerCase(),
      'blockchain.tx.value': '1',
    });
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
      // Confirmed in the background through the reader, which waits for one confirmation (#414).
      'blockchain.tx.wait.confirmations': 1,
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

  it('confirms through a network-scoped account without a reader', async () => {
    const { cdp, hashspan } = await client({ reader: false });
    const account = await cdp.evm.createAccount();
    const scoped = await account.useNetwork('base-sepolia');
    const { transactionHash } = await scoped.sendTransaction({
      transaction: { to: RECIPIENT, value: 4n },
    });
    const receipt = await scoped.waitForTransactionReceipt({ hash: transactionHash });
    expect(receipt.status).toBe('success');
    await hashspan.flush();

    const send = tracing.spanNamed('send 84532');
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.hash': transactionHash,
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
    });
    expect(api.requests).toContain('POST /rpc/v1/base-sepolia/mock-token');
    expect(confirm.attributes['blockchain.tx.wait.confirmations']).toBe(1);
  });

  it("records a network-scoped wait's confirmations, which the SDK passes to viem", async () => {
    const { cdp, hashspan } = await client({ reader: false });
    const account = await cdp.evm.createAccount();
    const scoped = await account.useNetwork('base-sepolia');
    const { transactionHash } = await scoped.sendTransaction({
      transaction: { to: RECIPIENT, value: 5n },
    });
    await control.waitForTransactionReceipt({ hash: transactionHash });
    // Only this test mines from here on: the receipt's block is the head (depth 1).
    await rpc('evm_setAutomine', [false]);
    try {
      let resolved = false;
      const wait = scoped
        .waitForTransactionReceipt({ hash: transactionHash, confirmations: 3 })
        .then((receipt) => {
          resolved = true;
          return receipt;
        });
      // The SDK's viem client checks at once: a wait that dropped the count resolves here, at depth 1.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(resolved).toBe(false);
      await rpc('anvil_mine', ['0x2']);
      const receipt = await wait;
      expect((await control.getBlockNumber()) - receipt.blockNumber + 1n).toBe(3n);
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 84532').attributes['blockchain.tx.wait.confirmations']).toBe(
      3,
    );
  }, 30_000);

  it('records 1 for the transactionHash form of a network-scoped wait', async () => {
    const { cdp, hashspan } = await client({ reader: false });
    const account = await cdp.evm.createAccount();
    const scoped = await account.useNetwork('base-sepolia');
    const { transactionHash } = await scoped.sendTransaction({
      transaction: { to: RECIPIENT, value: 6n },
    });
    await scoped.waitForTransactionReceipt({ transactionHash });
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 84532').attributes['blockchain.tx.wait.confirmations']).toBe(
      1,
    );
  });

  it("records the CDP API's error type on a failed send and rethrows the SDK's error", async () => {
    const { cdp } = await client();
    const account = await cdp.evm.createAccount();
    api.failNextSend({ status: 400, errorType: 'invalid_request', errorMessage: 'mock: rejected' });
    await expect(
      account.sendTransaction({
        network: 'base-sepolia',
        transaction: { to: RECIPIENT, value: 1n },
      }),
    ).rejects.toMatchObject({ name: 'APIError', errorType: 'invalid_request' });

    const send = tracing.spanNamed('send 84532');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe('invalid_request');
    expect(send.events[0]?.attributes?.['exception.type']).toBe('APIError');
  });
});
