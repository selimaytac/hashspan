import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
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
import { type Address, createPublicClient, createWalletClient, http, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAnvil } from '../../viem/test/start-anvil.js';
import { withHashspan } from '../src/index.js';
import { testUsdAbi, testUsdBytecode } from './token/test-usd.js';
import { setupTracing, type TestTracing } from './tracing.js';

// What the spans tell apart when a paid request, the tool that made it, or a retry fails (#331). The agent's tool call
// is an active span of the test's own: hashspan's spans take it as their parent like a framework's tool span.
// Covered elsewhere: a settlement whose receipt does not carry the payment (verified false) in verify.test.ts, and a
// settlement whose confirmation gives up (timeout) in rpc-faults.int.test.ts ('a receipt that stays null').
const NETWORK = `eip155:${foundry.id}` as const;
const PRICE = 10_000n;
const PAY_TO = '0x00000000000000000000000000000000000000cc';
const FACILITATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const agent = privateKeyToAccount(generatePrivateKey());

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
      args: [agent.address, 100n * PRICE],
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

type Handler = (attempt: number) => { status: number; body: string };

/**
 * A paid API at `GET /weather` in the order of the SDK's Express middleware (@x402/express 2.28, `paymentMiddleware`):
 * verify, run the handler, then settle only if it answered below 400, else cancel and send the failure-path
 * settlement headers. With `flow: 'upfront'` the SDK settles before the handler runs, so a failed handler leaves a
 * settled payment.
 */
async function paidApi(handler: Handler, flow?: 'upfront'): Promise<typeof fetch> {
  const facilitator = new x402Facilitator();
  const signer = toFacilitatorEvmSigner({
    ...facilitatorWallet,
    address: facilitatorWallet.account.address,
  } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0]);
  registerFacilitatorScheme(facilitator, { signer, networks: NETWORK });
  const facilitatorClient: FacilitatorClient = {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
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
        price: {
          asset: token,
          amount: String(PRICE),
          extra: { name: 'Test USD', version: '1', ...(flow ? { paymentFlow: flow } : {}) },
        },
        maxTimeoutSeconds: 60,
      },
      description: 'Weather',
      mimeType: 'application/json',
    },
  });
  await server.initialize();
  let attempt = 0;

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
    const answer = handler(++attempt);
    if (answer.status >= 400) {
      const canceled = await result.cancellationDispatcher.cancel({
        reason: 'handler_failed',
        responseStatus: answer.status,
      });
      const headers = server.createFailurePathSettlementHeaders(
        canceled,
        result.beforeHandlerSettlement,
        result.paymentPayload,
        null,
      );
      return new Response(answer.body, { status: answer.status, headers: headers ?? {} });
    }
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
    return new Response(answer.body, { status: answer.status, headers: settled.headers });
  };
}

function agentFetch(api: typeof fetch) {
  const client = new x402Client();
  const hashspan = withHashspan(client, { reader });
  registerClientScheme(client, { signer: agent, networks: [NETWORK] });
  client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
  return { fetch: wrapFetchWithPayment(api, client), hashspan };
}

/** Runs `body` as a tool call: an active `execute_tool weather` span that ends with error status if `body` throws. */
async function toolCall<T>(body: () => Promise<T>): Promise<T | Error> {
  return trace.getTracer('outcomes').startActiveSpan('execute_tool weather', async (span: Span) => {
    try {
      return await body();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      return error as Error;
    } finally {
      span.end();
    }
  });
}

const PAYMENT_SPAN = `payment ${foundry.id}`;
const CONFIRM_SPAN = `confirm ${foundry.id}`;

/** The tool span, its payment spans, and the confirm spans linked to them. */
function recorded() {
  const spans = tracing.spans();
  const [tool, ...others] = spans.filter((s) => s.name === 'execute_tool weather');
  expect(others).toEqual([]);
  const payments = spans.filter((s) => s.name === PAYMENT_SPAN);
  const confirms = spans.filter((s) => s.name === CONFIRM_SPAN);
  for (const span of [...payments, ...confirms]) {
    expect(span.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId);
  }
  const settled = payments.filter((s) => s.attributes['blockchain.payment.status'] === 'settled');
  for (const payment of settled) {
    const confirm = confirms.find(
      (c) => c.attributes['blockchain.tx.hash'] === payment.attributes['blockchain.tx.hash'],
    );
    expect(confirm?.links.map((l) => l.context.spanId)).toEqual([payment.spanContext().spanId]);
    expect(payment.attributes['blockchain.payment.verified']).toBe(true);
  }
  return { tool: tool as NonNullable<typeof tool>, payments, settled, confirms };
}

const failed = (r: Response) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
};

describe('a paid request that fails, and the tool call that made it', () => {
  it('handler fails (500), default flow: the payment is not settled', async () => {
    const { fetch, hashspan } = agentFetch(await paidApi(() => ({ status: 500, body: 'boom' })));
    await toolCall(async () => failed(await fetch('http://api.test/weather')));
    expect(await hashspan.flush()).toBe(true);

    const { tool, payments, settled, confirms } = recorded();
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(payments).toHaveLength(1);
    expect(settled).toEqual([]);
    expect(payments[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(payments[0]?.attributes['error.type']).toBe('no_settlement');
    expect(confirms).toEqual([]);
  });

  it('handler fails (500), upfront flow: the payment is settled and verified, only the tool span shows the failure', async () => {
    const { fetch, hashspan } = agentFetch(
      await paidApi(() => ({ status: 500, body: 'boom' }), 'upfront'),
    );
    let status: number | undefined;
    await toolCall(async () => {
      const response = await fetch('http://api.test/weather');
      status = response.status;
      return failed(response);
    });
    expect(await hashspan.flush()).toBe(true);

    expect(status).toBe(500);
    const { tool, payments, settled, confirms } = recorded();
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(payments).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(payments[0]?.status.code).toBe(SpanStatusCode.UNSET);
    // Nothing on the payment span says the paid request failed: the x402 client hooks never see its status.
    expect(Object.keys(payments[0]?.attributes ?? {}).filter((k) => k.startsWith('http.'))).toEqual(
      [],
    );
    expect(confirms[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('request succeeds (200) and the tool fails on the response: a settled payment under a failed tool span', async () => {
    const { fetch, hashspan } = agentFetch(
      await paidApi(() => ({ status: 200, body: 'not json' })),
    );
    await toolCall(async () => (await fetch('http://api.test/weather')).json());
    expect(await hashspan.flush()).toBe(true);

    const { tool, settled } = recorded();
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(settled).toHaveLength(1);
  });
});

describe('a tool call that retries a paid request', () => {
  it('pays again: two settled payments with their own settlement transactions', async () => {
    const { fetch, hashspan } = agentFetch(
      await paidApi((n) =>
        n === 1 ? { status: 200, body: 'not json' } : { status: 200, body: '{"t":21}' },
      ),
    );
    await toolCall(async () => {
      try {
        return await (await fetch('http://api.test/weather')).json();
      } catch {
        return (await fetch('http://api.test/weather')).json();
      }
    });
    expect(await hashspan.flush()).toBe(true);

    const { tool, payments, settled } = recorded();
    expect(tool.status.code).toBe(SpanStatusCode.UNSET);
    expect(payments).toHaveLength(2);
    expect(settled).toHaveLength(2);
    expect(new Set(settled.map((s) => s.attributes['blockchain.tx.hash'])).size).toBe(2);
  });

  it('first attempt not settled (503), the retry settled: one real payment out of two signed', async () => {
    const { fetch, hashspan } = agentFetch(
      await paidApi((n) =>
        n === 1 ? { status: 503, body: 'busy' } : { status: 200, body: '{"t":21}' },
      ),
    );
    await toolCall(async () => {
      const first = await fetch('http://api.test/weather');
      return first.ok ? first.json() : (await fetch('http://api.test/weather')).json();
    });
    expect(await hashspan.flush()).toBe(true);

    const { tool, payments, settled } = recorded();
    expect(tool.status.code).toBe(SpanStatusCode.UNSET);
    expect(payments).toHaveLength(2);
    expect(settled).toHaveLength(1);
    expect(payments.find((s) => s !== settled[0])?.attributes['error.type']).toBe('no_settlement');
  });
});
