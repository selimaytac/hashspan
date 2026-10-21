// Drives the batch-settlement flows of the corpus (E5) against a running facilitator: the SDK's client, resource
// server and channel manager run in this process, as in packages/x402/test/batch-settlement.int.test.ts, and the
// facilitator is the target, reached over HTTP. The paid API is a function, never a socket; the client reads the
// chain from Anvil directly. The SDK signs its own payloads at run time; none of them is written anywhere.
import { x402Client } from '@x402/core/client';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/core/server';
import { toClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme as ClientScheme } from '@x402/evm/batch-settlement/client';
import { BatchSettlementEvmScheme as ServerScheme } from '@x402/evm/batch-settlement/server';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainOf, moved, readBalances } from './chain.mjs';
import { CALL_TIMEOUT_MS } from './conformance.mjs';
import { ACCOUNTS, NETWORK, PAY_TO, TOKEN, TOKEN_DOMAIN } from './corpus.mjs';
import { sanitize } from './diff.mjs';

/** The paid API of a flow, served by the SDK's resource server in this process. */
async function paidApi(flow, facilitatorClient) {
  const scheme = new ServerScheme(PAY_TO, { enforceMinDeposit: false });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);
  const channels = scheme.createChannelManager(facilitatorClient, NETWORK, TOKEN);
  const server = new x402HTTPResourceServer(resourceServer, {
    'GET /weather': {
      accepts: {
        scheme: 'batch-settlement',
        network: NETWORK,
        payTo: PAY_TO,
        price: {
          asset: TOKEN,
          amount: flow.price,
          extra: { ...TOKEN_DOMAIN, assetTransferMethod: 'eip3009' },
        },
        maxTimeoutSeconds: 60,
      },
      description: 'Weather',
      mimeType: 'application/json',
    },
  });
  await server.initialize();
  const settle = flow.charge === undefined ? undefined : { amount: flow.charge };
  const api = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const adapter = {
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
      settle,
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

/** One step of a flow, recorded as `ok` or its error text. */
async function attempt(fn) {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return sanitize(`error: ${error?.message ?? error}`);
  }
}

/**
 * Runs one flow; returns the observation checkExpectations() reads: the paid requests' statuses and each server
 * step's outcome as steps, and what moved for the receiver, the flow's payer and the batch-settlement contract.
 */
export async function runFlow(flow, { facilitatorUrl, rpcUrl }) {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const before = await readBalances(rpcUrl);
  const steps = [];
  const setup = await attempt(async () => {
    const { api, channels } = await paidApi(flow, facilitatorClient);
    const reader = createPublicClient({ chain: chainOf(rpcUrl), transport: http(rpcUrl) });
    const payer = privateKeyToAccount(ACCOUNTS[flow.payer]);
    const client = new x402Client();
    client.register(
      NETWORK,
      new ClientScheme(toClientEvmSigner(payer, reader), {
        depositPolicy: { depositMultiplier: 5 },
      }),
    );
    client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: TOKEN }] });
    const paidFetch = wrapFetchWithPayment(api, client);
    for (let i = 0; i < flow.requests; i++) {
      const response = await paidFetch('http://api.test/weather');
      await response.arrayBuffer();
      steps.push({ request: i + 1, status: response.status });
    }
    for (const action of flow.server) {
      const outcome = await attempt(async () => {
        if (action === 'refund') await channels.refund();
        else if (action === 'claimAndSettle') await channels.claimAndSettle();
        else if (action === 'stopWithFlush') {
          channels.start({
            claimIntervalSecs: 3600,
            settleIntervalSecs: 3600,
            refundIntervalSecs: 3600,
          });
          await channels.stop({ flush: true });
        } else throw new Error(`unknown flow step ${action}`);
      });
      steps.push({ action, outcome });
    }
  });
  if (setup !== 'ok') steps.push({ action: 'flow', outcome: setup });
  const delta = moved(before, await readBalances(rpcUrl));
  return {
    steps,
    effect: { payTo: delta.payTo, payer: delta[flow.payer], contract: delta.contract },
  };
}
