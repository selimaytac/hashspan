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
import { toClientEvmSigner, toFacilitatorEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme as ClientScheme } from '@x402/evm/batch-settlement/client';
import { BatchSettlementEvmScheme as FacilitatorScheme } from '@x402/evm/batch-settlement/facilitator';
import { BatchSettlementEvmScheme as ServerScheme } from '@x402/evm/batch-settlement/server';
import { wrapFetchWithPayment } from '@x402/fetch';
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAnvil } from '../../viem/test/start-anvil.js';
import { withHashspan } from '../src/index.js';
import {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_CODE,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_CODE,
  MULTICALL3_ADDRESS,
  MULTICALL3_CODE,
} from './batch-settlement/contracts.js';
import { testUsdAbi, testUsdBytecode } from './token/test-usd.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Pays with x402's batch-settlement scheme on Anvil through the SDK's own client, resource server, channel manager
// and facilitator, all in this process: the first request deposits into a channel, every request charges it, and the
// server claims and settles the charges later. The scheme's contracts and Multicall3 run from code copied from Base
// Sepolia (batch-settlement/contracts.ts), installed at the SDK's fixed addresses; nothing leaves localhost.
const NETWORK = `eip155:${foundry.id}` as const;
const PRICE = 1000n;
const FUNDS = 1_000_000n;
const PAY_TO = '0x00000000000000000000000000000000000000cc';
// Anvil's first account, unlocked on the node, deploys and sends the facilitator's transactions.
const FACILITATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
// Signs the facilitator's claims and refunds; it sends nothing.
const authorizer = privateKeyToAccount(generatePrivateKey());
const PAYMENT_SPAN = `payment ${foundry.id}`;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
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
  const node = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC_URL) });
  for (const [address, bytecode] of [
    [BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_CODE],
    [ERC3009_DEPOSIT_COLLECTOR_ADDRESS, ERC3009_DEPOSIT_COLLECTOR_CODE],
    [MULTICALL3_ADDRESS, MULTICALL3_CODE],
  ] as const) {
    await node.setCode({ address, bytecode });
  }
  const deployed = await facilitatorWallet.deployContract({
    abi: testUsdAbi,
    bytecode: testUsdBytecode,
  });
  token = (await reader.waitForTransactionReceipt({ hash: deployed })).contractAddress as Address;
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

const balanceOf = (address: Address) =>
  reader.readContract({
    address: token,
    abi: testUsdAbi,
    functionName: 'balanceOf',
    args: [address],
  });

/**
 * A paid API at `GET /weather` that takes batch-settlement payments, built from the SDK's resource server, with a
 * facilitator in this process. With `settle`, each request is charged that part of the price. Returns the fetch
 * function and the server's channel manager, which claims and settles the charges.
 */
async function paidApi(options: { settle?: SettlementOverrides } = {}) {
  const signer = toFacilitatorEvmSigner({
    ...facilitatorWallet,
    address: facilitatorWallet.account.address,
  } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0]);
  const facilitator = new x402Facilitator().register(
    NETWORK,
    new FacilitatorScheme(signer, {
      address: authorizer.address,
      signTypedData: (params) => authorizer.signTypedData(params as never),
    }),
  );
  const facilitatorClient: FacilitatorClient = {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // The in-process facilitator answers synchronously, with network names typed as plain strings.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
  const scheme = new ServerScheme(PAY_TO, { enforceMinDeposit: false });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);
  const channels = scheme.createChannelManager(facilitatorClient, NETWORK, token);
  const server = new x402HTTPResourceServer(resourceServer, {
    'GET /weather': {
      accepts: {
        scheme: 'batch-settlement',
        network: NETWORK,
        payTo: PAY_TO,
        price: {
          asset: token,
          amount: String(PRICE),
          extra: { name: 'Test USD', version: '1', assetTransferMethod: 'eip3009' },
        },
        maxTimeoutSeconds: 60,
      },
      description: 'Weather',
      mimeType: 'application/json',
    },
  });
  await server.initialize();

  const api: typeof fetch = async (input, init) => {
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
    return new Response('{"temperature":21}', { status: 200, headers: settled.headers });
  };
  return { api, channels };
}

/** A paying agent with funds, whose x402 client deposits five times the price into a channel, traced with a reader. */
async function agentClient() {
  // An agent of its own for each test, so that each test opens a new channel.
  const agent = privateKeyToAccount(generatePrivateKey());
  await reader.waitForTransactionReceipt({
    hash: await facilitatorWallet.writeContract({
      address: token,
      abi: testUsdAbi,
      functionName: 'mint',
      args: [agent.address, FUNDS],
    }),
  });
  const client = new x402Client();
  // Before any other hook, as the README asks; the scheme registers hooks of its own.
  const hashspan = withHashspan(client, { reader });
  client.register(
    NETWORK,
    new ClientScheme(toClientEvmSigner(agent, reader), { depositPolicy: { depositMultiplier: 5 } }),
  );
  client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
  return { agent, client, hashspan };
}

describe('batch-settlement payments', () => {
  it('record the charge of each request as settled, never the deposit', async () => {
    const { api, channels } = await paidApi();
    const { agent, client, hashspan } = await agentClient();
    const paidFetch = wrapFetchWithPayment(api, client);
    for (let i = 0; i < 3; i++) {
      expect((await paidFetch('http://api.test/weather')).status).toBe(200);
    }
    expect(await hashspan.flush()).toBe(true);
    // The first request deposited into the channel's escrow, more than it was charged.
    const deposit = FUNDS - (await balanceOf(agent.address));
    expect(deposit).toBeGreaterThan(PRICE);
    const before = await balanceOf(PAY_TO);

    // Each payment span records the charge, no transaction, and no confirm span links to it.
    const spans = tracing.spans();
    expect(spans.map((span) => span.name)).toEqual([PAYMENT_SPAN, PAYMENT_SPAN, PAYMENT_SPAN]);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        'x402.scheme': 'batch-settlement',
        'blockchain.payment.status': 'settled',
        'blockchain.payment.amount': String(PRICE),
        'blockchain.payment.settled_amount': String(PRICE),
      });
      expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
      expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
    }

    // The server's claim and settlement pay the recipient what the payment spans recorded as settled.
    const { settle } = await channels.claimAndSettle();
    expect(settle?.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await balanceOf(PAY_TO)) - before).toBe(3n * PRICE);
  });

  it('record the charge when the server charges less than the price', async () => {
    const { api, channels } = await paidApi({ settle: { amount: '50%' } });
    const { client, hashspan } = await agentClient();
    const paidFetch = wrapFetchWithPayment(api, client);
    for (let i = 0; i < 3; i++) {
      expect((await paidFetch('http://api.test/weather')).status).toBe(200);
    }
    expect(await hashspan.flush()).toBe(true);
    expect(
      tracing
        .spans()
        .map((span) => [
          span.attributes['blockchain.payment.amount'],
          span.attributes['blockchain.payment.settled_amount'],
        ]),
    ).toEqual([
      ['1000', '500'],
      ['1000', '500'],
      ['1000', '500'],
    ]);
    const before = await balanceOf(PAY_TO);
    await channels.claimAndSettle();
    expect((await balanceOf(PAY_TO)) - before).toBe((3n * PRICE) / 2n);
  });
});
