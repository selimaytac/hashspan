// RPC faults on the reader of `@hashspan/x402`, through the fault proxy of the viem tests in front of Anvil. The
// payment goes through the paid API, so only the settlement's confirmation, through the reader and `watch()`, sees
// the faults. The settlement names a transfer mined on Anvil, as a stand-in; the fake payment carries no
// authorization, so `blockchain.payment.verified` is not checked here (see settlement.int.test.ts). For each fault:
// the paid request returns as it does untraced, the payment span keeps its settlement, the confirm span ends as
// `watch()`'s does, nothing is left pending and no rejection is unhandled.
import { SpanStatusCode } from '@opentelemetry/api';
import { wrapFetchWithPayment } from '@x402/fetch';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, type Hex, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fault,
  type FaultProxy,
  type FaultRule,
  startFaultProxy,
} from '../../viem/test/fault-proxy.js';
import { freePort } from '../../viem/test/free-port.js';
import { withHashspan } from '../src/index.js';
import { paidApi, settledWith, testClient } from './fake-x402.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const CONFIRM_TIMEOUT_MS = 2_500;
const PAYMENT_SPAN = `payment ${baseSepolia.id}`;
const CONFIRM_SPAN = `confirm ${baseSepolia.id}`;

// Anvil with Base Sepolia's chain id, the network of the fake paid API.
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: baseSepolia.id,
});

let proxy: FaultProxy;
let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  await instance.start();
  proxy = await startFaultProxy(RPC_URL);
  [account] = (await createWalletClient({ transport: http(RPC_URL) }).getAddresses()) as [Address];
});
afterAll(async () => {
  await proxy.stop();
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/**
 * Faults on the receipt requests of the confirmation through `watch()`, with the `error.type` its confirm span ends
 * with, or undefined for one that ends with the receipt, as in `../../viem/test/rpc-faults.int.test.ts` (which covers
 * more). `watch()` polls again after a failed request, so a fault that lasts ends as a timeout.
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

/** Runs `run`, collecting the unhandled rejections raised until a little after it settled. */
async function collectingRejections<T>(run: () => Promise<T>): Promise<[T, unknown[]]> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [result, rejections];
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

/** A transfer mined on Anvil, which the fake facilitator reports as its settlement. */
async function settlementTransaction(): Promise<Hex> {
  const hash = await createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  }).sendTransaction({ to: RECIPIENT, value: 1n });
  await createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  }).waitForTransactionReceipt({ hash, pollingInterval: 50 });
  return hash;
}

/** Pays for a request settled by `transaction`, traced with a reader through the proxy unless `traced` is false. */
async function pay(transaction: Hex, traced = true) {
  const client = testClient();
  const reader = createPublicClient({
    chain: baseSepolia,
    transport: http(proxy.url, { retryCount: 0, timeout: 1_000 }),
    pollingInterval: 50,
  });
  const hashspan = traced
    ? withHashspan(client, { reader, confirmTimeoutMs: CONFIRM_TIMEOUT_MS })
    : undefined;
  const response = await wrapFetchWithPayment(
    paidApi(() => settledWith({ transaction })),
    client,
  )('https://api.example.com/weather');
  return {
    status: response.status,
    body: await response.text(),
    flushed: await hashspan?.flush({ timeoutMs: 10_000 }),
  };
}

describe('a payment whose reader fails while confirming the settlement', () => {
  it('confirms the settlement without a fault', async () => {
    const transaction = await settlementTransaction();
    proxy.set({});
    await expect(pay(transaction)).resolves.toMatchObject({ status: 200, flushed: true });
    expect(tracing.spanNamed(CONFIRM_SPAN).attributes['blockchain.tx.status']).toBe('success');
  });

  it.each(Object.entries(RECEIPT_FAULTS))('%s', async (_, { faults, errorType }) => {
    const transaction = await settlementTransaction();
    proxy.set(faults);
    const untraced = await pay(transaction, false);
    expect(untraced.status).toBe(200);

    proxy.set(faults);
    const [{ status, body, flushed }, rejections] = await collectingRejections(() =>
      pay(transaction),
    );

    expect({ status, body }).toEqual({ status: untraced.status, body: untraced.body });
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.status.code).toBe(SpanStatusCode.UNSET);
    expect(payment.attributes['blockchain.payment.status']).toBe('settled');
    expect(payment.attributes['blockchain.tx.hash']).toBe(transaction);
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
