import { SpanStatusCode } from '@opentelemetry/api';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import {
  type FacilitatorClient,
  type HTTPAdapter,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme as registerClientScheme } from '@x402/evm/exact/client';
import { registerExactEvmScheme as registerFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { registerExactEvmScheme as registerServerScheme } from '@x402/evm/exact/server';
import { wrapFetchWithPayment } from '@x402/fetch';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, http, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { testUsdAbi, testUsdBytecode } from './token/test-usd.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Settles real EIP-3009 payments on Anvil through the SDK's own resource server, facilitator and client, all in
// this process; nothing leaves localhost.
const PORT = 18564;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const NETWORK = `eip155:${foundry.id}` as const;
const PRICE = 10_000n;
const PAY_TO = '0x00000000000000000000000000000000000000cc';
// Anvil's first account, unlocked on the node, deploys and settles as the facilitator. The paying agent is a
// throwaway account: it only signs, and needs no ether.
const FACILITATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const agent = privateKeyToAccount(generatePrivateKey());
const PAYMENT_SPAN = `payment ${foundry.id}`;
const CONFIRM_SPAN = `confirm ${foundry.id}`;

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
  const deployed = await facilitatorWallet.deployContract({
    abi: testUsdAbi,
    bytecode: testUsdBytecode,
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: deployed });
  token = receipt.contractAddress as Address;
  await reader.waitForTransactionReceipt({
    hash: await facilitatorWallet.writeContract({
      address: token,
      abi: testUsdAbi,
      functionName: 'mint',
      args: [agent.address, 10n * PRICE],
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

/**
 * A paid API at `GET /weather`, built from the SDK's resource server, with a facilitator in this process that
 * settles from Anvil account #0. `receiptTimeout` makes the facilitator give up waiting for the receipt.
 */
async function paidApi(options: { receiptTimeout?: boolean } = {}): Promise<typeof fetch> {
  const facilitator = new x402Facilitator();
  const signer = toFacilitatorEvmSigner({
    ...facilitatorWallet,
    address: facilitatorWallet.account.address,
    ...(options.receiptTimeout
      ? {
          waitForTransactionReceipt: async () => {
            throw new Error('timed out waiting for the receipt');
          },
        }
      : {}),
  } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0]);
  registerFacilitatorScheme(facilitator, { signer, networks: NETWORK });
  const facilitatorClient: FacilitatorClient = {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // The in-process facilitator answers synchronously, with network names typed as plain strings.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerServerScheme(resourceServer, { networks: [NETWORK] });
  const server = new x402HTTPResourceServer(resourceServer, {
    'GET /weather': {
      accepts: {
        scheme: 'exact',
        network: NETWORK,
        payTo: PAY_TO,
        price: { asset: token, amount: String(PRICE), extra: { name: 'Test USD', version: '1' } },
        maxTimeoutSeconds: 60,
      },
      description: 'Weather',
      mimeType: 'application/json',
    },
  });
  await server.initialize();

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
    const settled = await server.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      { request: context },
      undefined,
      result.beforeHandlerSettlement,
    );
    if (!settled.success) {
      const { status, headers, body } = settled.response;
      return new Response(JSON.stringify(body ?? {}), { status, headers });
    }
    return new Response('{"temperature":21}', { status: 200, headers: settled.headers });
  };
}

/** The agent's x402 client, paying with its EIP-3009 signature, traced with a reader. */
function agentClient() {
  const client = new x402Client();
  // Before any other hook, as the README asks.
  const hashspan = withHashspan(client, { reader });
  registerClientScheme(client, { signer: agent, networks: [NETWORK] });
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

describe('an EIP-3009 payment settled by the SDK facilitator', () => {
  it('is a settled payment span with a linked confirm span for the settling transaction', async () => {
    const { client, hashspan } = agentClient();
    const before = await balanceOf(PAY_TO);
    const response = await wrapFetchWithPayment(
      await paidApi(),
      client,
    )('http://api.test/weather?key=secret');
    expect(response.status).toBe(200);
    expect(await hashspan.flush()).toBe(true);
    expect((await balanceOf(PAY_TO)) - before).toBe(PRICE);

    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.attributes).toMatchObject({
      'blockchain.payment.status': 'settled',
      'blockchain.payment.payer': agent.address,
      'blockchain.payment.recipient': PAY_TO,
      'blockchain.payment.asset': token,
      'blockchain.payment.amount': String(PRICE),
      'x402.scheme': 'exact',
      'x402.resource': 'http://api.test',
    });
    const hash = payment.attributes['blockchain.tx.hash'] as string;
    const receipt = await reader.getTransactionReceipt({ hash: hash as `0x${string}` });
    // The facilitator, not the agent, sent the settling transaction.
    expect(receipt.from.toLowerCase()).toBe(facilitatorWallet.account.address.toLowerCase());

    const confirm = tracing.spanNamed(CONFIRM_SPAN);
    expect(confirm.links.map((link) => link.context.spanId)).toEqual([
      payment.spanContext().spanId,
    ]);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(receipt.blockNumber),
    });
  });

  it('is pending when the facilitator did not see the receipt, and the confirm span resolves it', async () => {
    const { client, hashspan } = agentClient();
    await wrapFetchWithPayment(
      await paidApi({ receiptTimeout: true }),
      client,
    )('http://api.test/weather');
    expect(await hashspan.flush()).toBe(true);

    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.attributes['blockchain.payment.status']).toBe('pending');
    expect(payment.status.code).toBe(SpanStatusCode.UNSET);
    const confirm = tracing.spanNamed(CONFIRM_SPAN);
    expect(confirm.attributes['blockchain.tx.hash']).toBe(payment.attributes['blockchain.tx.hash']);
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  });

  it('is not settled when the agent cannot pay', async () => {
    // Anvil's account #2, which holds no Test USD.
    // A throwaway account that holds no Test USD.
    const poor = privateKeyToAccount(generatePrivateKey());
    const client = new x402Client();
    const hashspan = withHashspan(client, { reader });
    registerClientScheme(client, { signer: poor, networks: [NETWORK] });
    client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
    const response = await wrapFetchWithPayment(await paidApi(), client)('http://api.test/weather');
    expect(response.status).toBe(402);
    expect(await hashspan.flush()).toBe(true);

    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.status.code).toBe(SpanStatusCode.ERROR);
    // Verification refused it: the server answers 402 again, with requirements but no settlement.
    expect(response.headers.has('PAYMENT-RESPONSE')).toBe(false);
    expect(payment.attributes['error.type']).toBe('no_settlement');
    expect(payment.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(tracing.spans().map((span) => span.name)).toEqual([PAYMENT_SPAN]);
  });
});
