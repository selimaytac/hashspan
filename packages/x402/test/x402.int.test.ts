import { context, trace } from '@opentelemetry/api';
import { wrapFetchWithPayment } from '@x402/fetch';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { PAY_TO, paidApi, settledWith, testClient } from './fake-x402.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18563;
const RPC_URL = `http://127.0.0.1:${PORT}`;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: baseSepolia.id,
});
const wallet = createWalletClient({ chain: baseSepolia, transport: http(RPC_URL) });
const reader = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
let facilitator: Address;

/**
 * A paid API whose facilitator settles on Anvil: it sends a transaction from an Anvil account (a plain transfer,
 * standing in for `transferWithAuthorization`) and reports its hash, after `delayMs`.
 */
const settlingApi = (delayMs = 0) =>
  paidApi(async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const transaction = await wallet.sendTransaction({
      account: facilitator,
      to: PAY_TO,
      value: 1n,
    });
    return settledWith({ transaction });
  });

let tracing: TestTracing;
beforeAll(async () => {
  await instance.start();
  [facilitator] = (await wallet.getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('a settlement confirmed through the reader', () => {
  it('gets a confirm span linked to the payment span, with block, gas and fee', async () => {
    const client = testClient();
    const hashspan = withHashspan(client, { reader });
    const tool = trace.getTracer('test').startSpan('execute_tool weather');
    await context.with(trace.setSpan(context.active(), tool), () =>
      wrapFetchWithPayment(settlingApi(), client)('https://api.example.com/weather'),
    );
    tool.end();
    expect(await hashspan.flush()).toBe(true);

    const payment = tracing.spanNamed(`payment ${baseSepolia.id}`);
    const confirm = tracing.spanNamed(`confirm ${baseSepolia.id}`);
    expect(confirm.links.map((link) => link.context.spanId)).toEqual([
      payment.spanContext().spanId,
    ]);
    expect(confirm.attributes['blockchain.tx.hash']).toBe(payment.attributes['blockchain.tx.hash']);
    expect(confirm.attributes).toMatchObject({ 'blockchain.tx.status': 'success' });
    expect(confirm.attributes['blockchain.block.number']).toBeGreaterThan(0);
    expect(confirm.attributes['blockchain.tx.fee']).toBeDefined();
  });

  it('is awaited by a flush that started before the response arrived', async () => {
    const client = testClient();
    const hashspan = withHashspan(client, { reader });
    let arrived = false;
    const api = settlingApi(200);
    const call = wrapFetchWithPayment((input, init) => {
      if (new Request(input, init).headers.has('PAYMENT-SIGNATURE')) arrived = true;
      return api(input, init);
    }, client)('https://api.example.com/weather');
    await vi.waitFor(() => expect(arrived).toBe(true));

    expect(await hashspan.flush({ timeoutMs: 10_000 })).toBe(true);
    expect(
      tracing
        .spans()
        .map((span) => span.name)
        .sort(),
    ).toEqual([`confirm ${baseSepolia.id}`, `payment ${baseSepolia.id}`]);
    await call;
  });
});
