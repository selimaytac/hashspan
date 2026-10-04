// RPC faults on the reader of `@hashspan/cdp`, through the fault proxy of the viem tests in front of Anvil. The send
// goes through the CDP API (here a local stand-in), so only the confirmation, through the reader and `watch()`, sees
// the faults. For each fault: the SDK call returns as it does untraced, the send span is untouched, the confirm span
// ends as `watch()`'s does, nothing is left pending and no rejection is unhandled. An ending that is a defect also has
// an `it.fails` test with the ending it should have, tagged with its issue (`// finding: #<issue>`).
import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FaultProxy, RECEIPT_FAULTS, startFaultProxy } from '../../viem/test/fault-proxy.js';
import { freePort } from '../../viem/test/free-port.js';
import { withHashspan } from '../src/index.js';
import { startMockCdpApi, throwawayCredentials } from './mock-cdp-api.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const CONFIRM_TIMEOUT_MS = 2_500;

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
let proxy: FaultProxy;
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
  proxy = await startFaultProxy(RPC_URL);
  const [account] = (await createWalletClient({ transport: http(RPC_URL) }).getAddresses()) as [
    Address,
  ];
  api = await startMockCdpApi({ rpcUrl: RPC_URL, account });
});
afterAll(async () => {
  await api.close();
  await proxy.stop();
  await instance.stop();
  vi.restoreAllMocks();
  // Nothing left localhost.
  expect(fetched.filter((url) => !url.startsWith('http://127.0.0.1'))).toEqual([]);
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

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

/** Sends a transfer from a new account of a CDP client, traced with a reader through the proxy unless `traced` is false. */
async function sendThroughCdp(traced = true) {
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient({ ...throwawayCredentials(), basePath: api.basePath });
  const reader = createPublicClient({
    chain: baseSepolia,
    transport: http(proxy.url, { retryCount: 0, timeout: 1_000 }),
    pollingInterval: 50,
  });
  const hashspan = traced
    ? withHashspan(cdp, { reader, confirmTimeoutMs: CONFIRM_TIMEOUT_MS })
    : undefined;
  const account = await cdp.evm.createAccount();
  const result = await account.sendTransaction({
    network: 'base-sepolia',
    transaction: { to: RECIPIENT, value: 1n },
  });
  return { result, flushed: await hashspan?.flush({ timeoutMs: 10_000 }) };
}

describe('an account sendTransaction whose reader fails', () => {
  it('confirms the transaction without a fault', async () => {
    proxy.set({});
    await expect(sendThroughCdp()).resolves.toMatchObject({ flushed: true });
    expect(tracing.spanNamed('confirm 84532').attributes['blockchain.tx.status']).toBe('success');
  });

  it.each(Object.entries(RECEIPT_FAULTS))('%s', async (_, { faults, errorType }) => {
    proxy.set(faults);
    const untraced = await sendThroughCdp(false);
    expect(Object.keys(untraced.result)).toEqual(['transactionHash']);

    proxy.set(faults);
    const [{ result, flushed }, rejections] = await collectingRejections(() => sendThroughCdp());

    expect(Object.keys(result)).toEqual(Object.keys(untraced.result));
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    const send = tracing.spanNamed('send 84532');
    expect(send.status.code).toBe(SpanStatusCode.UNSET);
    expect(send.attributes['blockchain.tx.hash']).toBe(result.transactionHash);
    const confirms = tracing.spans().filter((s) => s.name === 'confirm 84532');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirms[0]?.attributes['error.type']).toBe(errorType);
    expect(confirms[0]?.attributes['blockchain.tx.status']).toBeUndefined();
  });

  for (const [fault, { faults, finding }] of Object.entries(RECEIPT_FAULTS)) {
    if (!finding) continue;
    // finding: see the row's issue.
    it.fails(`${fault}: confirms the transaction [finding: ${finding}]`, async () => {
      proxy.set(faults);
      await sendThroughCdp();
      expect(tracing.spanNamed('confirm 84532').attributes['blockchain.tx.status']).toBe('success');
    });
  }
});
