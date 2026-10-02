import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import {
  type FacilitatorClient,
  type HTTPAdapter,
  type SettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme as registerClientScheme } from '@x402/evm/exact/client';
import { registerExactEvmScheme as registerFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { registerExactEvmScheme as registerServerScheme } from '@x402/evm/exact/server';
import { UptoEvmScheme as UptoClientScheme } from '@x402/evm/upto/client';
import { UptoEvmScheme as UptoFacilitatorScheme } from '@x402/evm/upto/facilitator';
import { UptoEvmScheme as UptoServerScheme } from '@x402/evm/upto/server';
import { wrapFetchWithPayment } from '@x402/fetch';
import { Instance } from 'prool';
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  maxUint256,
  parseEther,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  EXACT_PROXY_ADDRESS,
  EXACT_PROXY_CODE,
  PERMIT2_ADDRESS,
  PERMIT2_CODE,
  UPTO_PROXY_ADDRESS,
  UPTO_PROXY_CODE,
} from './permit2/contracts.js';
import { testUsdAbi, testUsdBytecode } from './token/test-usd.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Settles real Permit2 payments, `exact` and `upto`, on Anvil through the SDK's own resource server, facilitator
// and client, all in this process. Permit2 and the x402 proxies run from code copied from Base Sepolia
// (permit2/contracts.ts), installed at their canonical addresses; nothing leaves localhost.
const PORT = 18566;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const NETWORK = `eip155:${foundry.id}` as const;
const PRICE = 10_000n;
const PAY_TO = '0x00000000000000000000000000000000000000cc';
// Anvil's first account, unlocked on the node, deploys and settles as the facilitator. The paying agent is a
// throwaway account; it needs ether once, to approve Permit2.
const FACILITATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const agent = privateKeyToAccount(generatePrivateKey());
const PAYMENT_SPAN = `payment ${foundry.id}`;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: foundry.id,
});
const reader = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
const facilitatorWallet = createWalletClient({
  account: FACILITATOR,
  chain: foundry,
  transport: http(RPC_URL),
}).extend(publicActions);
let token: Address;

beforeAll(async () => {
  await instance.start();
  const node = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC_URL) });
  for (const [address, bytecode] of [
    [PERMIT2_ADDRESS, PERMIT2_CODE],
    [EXACT_PROXY_ADDRESS, EXACT_PROXY_CODE],
    [UPTO_PROXY_ADDRESS, UPTO_PROXY_CODE],
  ] as const) {
    await node.setCode({ address, bytecode });
  }
  const deployed = await facilitatorWallet.deployContract({
    abi: testUsdAbi,
    bytecode: testUsdBytecode,
  });
  token = (await reader.waitForTransactionReceipt({ hash: deployed })).contractAddress as Address;
  await reader.waitForTransactionReceipt({
    hash: await facilitatorWallet.writeContract({
      address: token,
      abi: testUsdAbi,
      functionName: 'mint',
      args: [agent.address, 10n * PRICE],
    }),
  });
  // Permit2 moves the agent's tokens within the allowance the agent gave it once.
  await node.setBalance({ address: agent.address, value: parseEther('1') });
  const agentWallet = createWalletClient({
    account: agent,
    chain: foundry,
    transport: http(RPC_URL),
  });
  await reader.waitForTransactionReceipt({
    hash: await agentWallet.writeContract({
      address: token,
      abi: testUsdAbi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    }),
  });
});
afterAll(async () => {
  await instance.stop();
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

type Scheme = 'exact' | 'upto';

/**
 * A paid API at `GET /weather` that takes a Permit2 payment of `scheme`, built from the SDK's resource server, with a
 * facilitator in this process that settles from Anvil account #0. With `settle`, an `upto` payment settles that
 * amount. With `replay`, the API settles the first payment only, and answers later ones with the first settlement.
 */
async function paidApi(
  scheme: Scheme,
  options: { settle?: SettlementOverrides; replay?: boolean } = {},
): Promise<typeof fetch> {
  const facilitator = new x402Facilitator();
  const signer = toFacilitatorEvmSigner({
    ...facilitatorWallet,
    address: facilitatorWallet.account.address,
  } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0]);
  const resourceServer = new x402ResourceServer({
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // The in-process facilitator answers synchronously, with network names typed as plain strings.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  } satisfies FacilitatorClient);
  if (scheme === 'exact') {
    registerFacilitatorScheme(facilitator, { signer, networks: NETWORK });
    registerServerScheme(resourceServer, { networks: [NETWORK] });
  } else {
    facilitator.register(NETWORK, new UptoFacilitatorScheme(signer));
    resourceServer.register(NETWORK, new UptoServerScheme());
  }
  const server = new x402HTTPResourceServer(resourceServer, {
    'GET /weather': {
      accepts: {
        scheme,
        network: NETWORK,
        payTo: PAY_TO,
        price: {
          asset: token,
          amount: String(PRICE),
          extra: { assetTransferMethod: 'permit2', name: 'Test USD', version: '1' },
        },
        maxTimeoutSeconds: 60,
      },
      description: 'Weather',
      mimeType: 'application/json',
    },
  });
  await server.initialize();

  let first: Headers | undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const adapter: HTTPAdapter = {
      getHeader: (name) => request.headers.get(name) ?? undefined,
      getMethod: () => request.method,
      getPath: () => url.pathname,
      getUrl: () => request.url,
      getAcceptHeader: () => request.headers.get('accept') ?? '',
      getUserAgent: () => request.headers.get('user-agent') ?? '',
    };
    const context = { adapter, path: url.pathname, method: request.method };
    const result = await server.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      const { status, headers, body } = result.response;
      return new Response(JSON.stringify(body ?? {}), { status, headers });
    }
    if (result.type === 'no-payment-required') return new Response('{}');
    if (options.replay && first) {
      return new Response('{"temperature":21}', { status: 200, headers: first });
    }
    const settled = await server.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      { request: context },
      options.settle,
      result.beforeHandlerSettlement,
    );
    if (!settled.success) {
      const { status, headers, body } = settled.response;
      return new Response(JSON.stringify(body ?? {}), { status, headers });
    }
    first = new Headers(settled.headers);
    return new Response('{"temperature":21}', { status: 200, headers: settled.headers });
  };
}

/** The agent's x402 client, paying with Permit2 signatures, traced with a reader. */
function agentClient(scheme: Scheme) {
  const client = new x402Client();
  // Before any other hook, as the README asks.
  const hashspan = withHashspan(client, { reader });
  if (scheme === 'exact') registerClientScheme(client, { signer: agent, networks: [NETWORK] });
  else client.register(NETWORK, new UptoClientScheme(agent));
  client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
  return { client, hashspan };
}

const balanceOf = (address: Address) =>
  reader.readContract({
    address: token,
    abi: testUsdAbi,
    functionName: 'balanceOf',
    args: [address],
  });

/** The settlement transaction recorded on `span`, and its receipt. */
async function settlementOf(span: { attributes: Record<string, unknown> }) {
  const hash = span.attributes['blockchain.tx.hash'] as Hex;
  return { hash, receipt: await reader.getTransactionReceipt({ hash }) };
}

describe('a Permit2 payment settled by the SDK facilitator', () => {
  it('is verified for an exact payment', async () => {
    const { client, hashspan } = agentClient('exact');
    const before = await balanceOf(PAY_TO);
    const response = await wrapFetchWithPayment(
      await paidApi('exact'),
      client,
    )('http://api.test/weather');
    expect(response.status).toBe(200);
    expect(await hashspan.flush()).toBe(true);
    expect((await balanceOf(PAY_TO)) - before).toBe(PRICE);

    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.attributes).toMatchObject({
      'blockchain.payment.status': 'settled',
      'blockchain.payment.payer': agent.address,
      'blockchain.payment.amount': String(PRICE),
      'x402.scheme': 'exact',
      'blockchain.payment.verified': true,
    });
    // A real settlement: the facilitator called the exact proxy, which had Permit2 transfer the payment.
    const { receipt } = await settlementOf(payment);
    expect(receipt.to?.toLowerCase()).toBe(EXACT_PROXY_ADDRESS.toLowerCase());
    expect(receipt.from.toLowerCase()).toBe(FACILITATOR.toLowerCase());
  });

  it('is verified for an upto payment that settles less than its maximum', async () => {
    const { client, hashspan } = agentClient('upto');
    const before = await balanceOf(PAY_TO);
    const response = await wrapFetchWithPayment(
      await paidApi('upto', { settle: { amount: '4000' } }),
      client,
    )('http://api.test/weather');
    expect(response.status).toBe(200);
    expect(await hashspan.flush()).toBe(true);
    expect((await balanceOf(PAY_TO)) - before).toBe(4_000n);

    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.attributes).toMatchObject({
      'blockchain.payment.status': 'settled',
      'blockchain.payment.amount': String(PRICE),
      'blockchain.payment.settled_amount': '4000',
      'x402.scheme': 'upto',
      'blockchain.payment.verified': true,
    });
    const { receipt } = await settlementOf(payment);
    expect(receipt.to?.toLowerCase()).toBe(UPTO_PROXY_ADDRESS.toLowerCase());
  });

  it('is not verified when the server reports the transaction of an identical earlier payment', async () => {
    const api = await paidApi('exact', { replay: true });
    const first = agentClient('exact');
    expect((await wrapFetchWithPayment(api, first.client)('http://api.test/weather')).status).toBe(
      200,
    );
    expect(await first.hashspan.flush()).toBe(true);
    const balance = await balanceOf(agent.address);
    const firstHash = tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.tx.hash'];
    tracing.exporter.reset();

    // Another client, as after a restart: it has not seen the first payment, the transaction's nonce tells.
    const second = agentClient('exact');
    expect((await wrapFetchWithPayment(api, second.client)('http://api.test/weather')).status).toBe(
      200,
    );
    expect(await second.hashspan.flush()).toBe(true);
    // The second payment was never settled: the agent paid nothing more.
    expect(await balanceOf(agent.address)).toBe(balance);
    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.attributes['blockchain.tx.hash']).toBe(firstHash);
    expect(payment.attributes['blockchain.payment.status']).toBe('settled');
    expect(payment.attributes['blockchain.payment.verified']).toBe(false);
  });
});
