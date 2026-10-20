// RPC faults on the reader of `@hashspan/mpp`, through the fault proxy of the viem tests in front of Anvil in Tempo
// mode. A real pull charge settles through an mppx server that talks to Anvil directly, so only the confirmation and
// the check of `blockchain.payment.verified`, through the reader and `watch()`, see the faults. For each fault: the
// paid request returns as it does untraced, the payment span keeps its settlement and gets a verdict only from a
// receipt it read, the confirm span ends as `watch()`'s does, nothing is left pending and no rejection is unhandled.

import { type Fault, type FaultProxy, type FaultRule, startFaultProxy } from '@hashspan/faults';
import { SpanStatusCode } from '@opentelemetry/api';
import { Mppx, tempo } from 'mppx/client';
import { createPublicClient, http } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectingRejections } from '../../viem/test/fault-checks.js';
import { withHashspan } from '../src/index.js';
import {
  CONFIRM_SPAN,
  chainClient,
  guardEgress,
  PAYER,
  PAYMENT_SPAN,
  paidApi,
  startTempoAnvil,
  URL_PAID,
} from './tempo-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const CONFIRM_TIMEOUT_MS = 2_500;

const anvil = await startTempoAnvil();
const { chain } = anvil;
let proxy: FaultProxy;
let tracing: TestTracing;
let egress: { blocked: string[] };

beforeAll(async () => {
  proxy = await startFaultProxy(anvil.rpcUrl);
});
afterAll(async () => {
  await proxy.stop();
  await anvil.instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
  egress = guardEgress();
});
afterEach(async () => {
  await tracing.teardown();
  expect(egress.blocked).toEqual([]);
});

/**
 * Faults on the receipt requests of the confirmation through `watch()`, with the `error.type` its confirm span ends
 * with, or undefined for one that ends with the receipt, as in `../../x402/test/rpc-faults.int.test.ts`.
 */
const RECEIPT_FAULTS: Record<
  string,
  { faults: Record<string, Fault | FaultRule | FaultRule[]>; errorType: string | undefined }
> = {
  'a request that never answers': {
    faults: { eth_getTransactionReceipt: { kind: 'hang' } },
    errorType: 'timeout',
  },
  'HTTP 429': {
    faults: { eth_getTransactionReceipt: { kind: 'http', status: 429 } },
    errorType: 'timeout',
  },
  'JSON-RPC -32603 (internal error)': {
    faults: { eth_getTransactionReceipt: { kind: 'rpc-error', code: -32603 } },
    errorType: 'timeout',
  },
  'a receipt that stays null': {
    faults: { eth_getTransactionReceipt: { kind: 'result', result: () => null } },
    errorType: 'timeout',
  },
  // The first receipt request finds none, the second fails, later ones find the receipt.
  'one failed receipt request between good ones': {
    faults: {
      eth_getTransactionReceipt: [
        { fault: { kind: 'result', result: () => null }, times: 1 },
        { fault: { kind: 'rpc-error', code: -32603 }, after: 1, times: 1 },
      ],
    },
    errorType: undefined,
  },
};

/** Pays once with a pull charge, traced with a reader through the proxy unless `traced` is false. */
async function pay(traced = true) {
  const api = paidApi(chain);
  const payerClient = chainClient(chain, PAYER);
  const mppx = Mppx.create({
    methods: [tempo({ account: PAYER, mode: 'pull', getClient: () => payerClient as never })],
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      api(new Request(input, init))) as never,
    polyfill: false,
  });
  const reader = createPublicClient({
    chain,
    transport: http(proxy.url, { retryCount: 0, timeout: 1_000 }),
    pollingInterval: 50,
  });
  const hashspan = traced
    ? withHashspan(mppx, { reader, confirmTimeoutMs: CONFIRM_TIMEOUT_MS })
    : undefined;
  const response = await mppx.fetch(URL_PAID);
  return {
    status: response.status,
    body: await response.text(),
    flushed: await hashspan?.flush({ timeoutMs: 10_000 }),
  };
}

describe('a payment whose reader fails while confirming and checking the settlement', () => {
  it('confirms and checks the settlement without a fault', async () => {
    proxy.set({});
    await expect(pay()).resolves.toMatchObject({ status: 200, flushed: true });
    expect(tracing.spanNamed(CONFIRM_SPAN).attributes['blockchain.tx.status']).toBe('success');
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.verified']).toBe(true);
  });

  it.each(Object.entries(RECEIPT_FAULTS))('%s', async (_, { faults, errorType }) => {
    proxy.set(faults);
    const untraced = await pay(false);
    expect(untraced.status).toBe(200);

    proxy.set(faults);
    const [{ status, body, flushed }, rejections] = await collectingRejections(() => pay());

    expect({ status, body }).toEqual({ status: untraced.status, body: untraced.body });
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.status.code).toBe(SpanStatusCode.UNSET);
    expect(payment.attributes['blockchain.payment.status']).toBe('settled');
    expect(payment.attributes['blockchain.tx.hash']).toMatch(/^0x[0-9a-f]{64}$/);
    // A verdict only from a receipt the reader returned.
    expect(payment.attributes['blockchain.payment.verified']).toBe(
      errorType === undefined ? true : undefined,
    );
    const confirms = tracing.spans().filter((s) => s.name === CONFIRM_SPAN);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.status.code).toBe(
      errorType === undefined ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
    );
    expect(confirms[0]?.attributes['error.type']).toBe(errorType);
    expect(confirms[0]?.attributes['blockchain.tx.status']).toBe(
      errorType === undefined ? 'success' : undefined,
    );
  });
});
