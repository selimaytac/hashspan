// A wait that times out, and a retry for the same transaction that starts while hashspan still looks for a
// replacement viem did not report (ADR 0008 amendment): the timeout stands, and the retry gets a confirm span of its
// own (docs/semconv.md, "One confirm span per transaction and tracker").
import { type Address, createPublicClient, createWalletClient, custom, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

let tracing: TestTracing;
let account: Address;

const reader = () =>
  createPublicClient({ chain: anvil, transport: http(RPC_URL), pollingInterval: 50 });
const rpc = (method: string, params: unknown[] = []) =>
  reader().request({ method: method as never, params: params as never });
const confirmOf = (hash: string) =>
  tracing
    .spans()
    .filter((s) => s.name === 'confirm 31337' && s.attributes['blockchain.tx.hash'] === hash);
const ms = ([seconds, nanos]: [number, number]) => seconds * 1_000 + nanos / 1e6;

beforeAll(async () => {
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** Rejects after `timeoutMs`, so a gate that is never reached fails the test instead of hanging it. */
const within = <T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${timeoutMs} ms`)), timeoutMs),
    ),
  ]);

describe('a retry while the replacement search of a timed-out wait runs', () => {
  it('keeps the timeout and gives the retry a confirm span of its own', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    // Holds the replacement search at its nonce read, the first request only the search sends, until the retry
    // resolved: the retry then starts inside the search, whatever the timing of the node.
    const upstream = http(RPC_URL)({ chain: anvil });
    let reached: () => void = () => {};
    const searching = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_getTransactionCount') {
          reached();
          await released;
        }
        return upstream.request({ method, params } as never);
      },
    });
    const client = createPublicClient({ chain: anvil, transport, pollingInterval: 50 }).extend(
      hashspan,
    );

    const nonce = await reader().getTransactionCount({ address: account, blockTag: 'pending' });
    // A nonce gap: A stays queued until B takes the nonce before it.
    const a = await wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce: nonce + 1 });
    const firstStart = Date.now();
    await expect(client.waitForTransactionReceipt({ hash: a, timeout: 1_500 })).rejects.toThrow(
      expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }),
    );
    const gaveUpAt = Date.now();
    await within(searching, 5_000, 'the replacement search starts');

    const retryStart = Date.now();
    await wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce });
    // Anvil mines A once B filled the gap; mined again in case it has not.
    if (
      (await reader()
        .getTransactionReceipt({ hash: a })
        .catch(() => undefined)) === undefined
    ) {
      await rpc('evm_mine');
    }
    const receipt = await client.waitForTransactionReceipt({ hash: a, timeout: 5_000 });
    expect(receipt.status).toBe('success');
    release();
    expect(await hashspan.flush({ timeoutMs: 15_000 })).toBe(true);

    const spans = confirmOf(a).sort((x, y) => ms(x.startTime) - ms(y.startTime));
    expect(spans).toHaveLength(2);
    const [timedOut, retried] = spans as [(typeof spans)[0], (typeof spans)[0]];
    expect(timedOut.attributes['error.type']).toBe('timeout');
    expect(timedOut.attributes['blockchain.tx.status']).toBeUndefined();
    // It ends when the wait gave up, not when the search or the retry finished. viem decides when that is: the floor
    // of the peer range (2.21.0) also gives up after `retryCount` polls, before the timeout, so only the order is
    // checked.
    expect(ms(timedOut.startTime)).toBeGreaterThanOrEqual(firstStart - 50);
    expect(ms(timedOut.endTime)).toBeLessThanOrEqual(gaveUpAt + 50);
    expect(ms(timedOut.endTime)).toBeLessThanOrEqual(retryStart + 50);
    expect(retried.attributes['blockchain.tx.status']).toBe('success');
    expect(retried.attributes['error.type']).toBeUndefined();
    expect(ms(retried.startTime)).toBeGreaterThanOrEqual(retryStart - 50);
  }, 20_000);
});
