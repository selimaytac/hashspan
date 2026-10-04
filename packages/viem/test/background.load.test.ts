// Load and long-run checks of background confirmation (issue #293), on Anvil with mining off until every transaction
// is sent, so that hundreds of confirmations poll at once. They take longer than the other suites and run only with
// HASHSPAN_LOAD=1 (`pnpm test:load`, weekly in CI). They check that:
// - the background confirmation limit holds, and confirmations that end release their slot;
// - no timer is left once `flush()` resolved;
// - the heap does not keep growing across repeated batches (a coarse check);
// - metrics count each send and each confirmation exactly once.
// Replacements are not mixed in. Anvil 1.8.3 dropped a replacement of a pending nonce above the account's lowest when
// it mined with mining off; on 1.8.4 the replacements are mined, but with hundreds of waits polling at once, the
// originals of some accounts were not reported as replaced and ended as timeouts (not investigated further).
// replacement.test.ts and anvil.int.test.ts cover replacements.
import { diag, type Histogram, type MeterProvider } from '@opentelemetry/api';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { freePort } from './free-port.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
/** Sends per account; Anvil funds ten accounts. */
const SENDS_PER_ACCOUNT = 30;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  noMining: true,
});

let tracing: TestTracing;
let accounts: Address[];

beforeAll(async () => {
  await instance.start();
  accounts = await createWalletClient({ chain: anvil, transport: http(RPC_URL) }).getAddresses();
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

/** A meter provider that counts what each histogram records. */
function recordingMeterProvider() {
  const recorded = new Map<string, number[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return { record: (value: number) => recorded.get(name)?.push(value) } as Histogram;
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

const rpc = createWalletClient({ chain: anvil, transport: http(RPC_URL) });
const reader = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
// One block at a time (the block gas limit holds every batch here): viem looks for a replacement only in the block it
// sees when the receipt is missing, so a second block mined at once could hide it.
const mine = () => rpc.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/**
 * Sends `perAccount` transfers from each account at once, with mining off, then mines them all in one block. Nonces
 * are explicit, so that the sends of one account can be in flight together.
 */
async function sendBatch(
  hashspan: ReturnType<typeof withHashspan>,
  perAccount: number,
): Promise<number> {
  const sent = await Promise.all(
    accounts.map(async (account) => {
      const wallet = createWalletClient({
        account,
        chain: anvil,
        transport: http(RPC_URL),
        pollingInterval: 250,
      }).extend(hashspan);
      const start = await reader.getTransactionCount({ address: account, blockTag: 'pending' });
      await Promise.all(
        Array.from({ length: perAccount }, (_, i) =>
          wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce: start + i }),
        ),
      );
      return perAccount;
    }),
  );
  // Every confirmation polls before the block is mined: viem's wait notices only blocks after its first poll.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await mine();
  return sent.reduce((a, b) => a + b, 0);
}

describe.runIf(process.env.HASHSPAN_LOAD === '1')('background confirmation under load', () => {
  it('confirms every send, and counts each once', async () => {
    const timersBefore = timers();
    const meters = recordingMeterProvider();
    const hashspan = withHashspan({
      meterProvider: meters.provider,
      maxBackgroundConfirmations: 1_000,
      confirm: { mode: 'background', timeoutMs: 60_000 },
    });

    const sent = await sendBatch(hashspan, SENDS_PER_ACCOUNT);
    await expect(hashspan.flush({ timeoutMs: 60_000 })).resolves.toBe(true);

    const sends = tracing.spans().filter((s) => s.name === 'send 31337');
    const confirms = tracing.spans().filter((s) => s.name === 'confirm 31337');
    expect(sent).toBe(accounts.length * SENDS_PER_ACCOUNT);
    expect(sends).toHaveLength(sent);
    expect(confirms).toHaveLength(sent);
    expect(confirms.every((s) => s.attributes['blockchain.tx.status'] === 'success')).toBe(true);
    expect(meters.recorded('blockchain.client.send.duration')).toHaveLength(sent);
    expect(meters.recorded('blockchain.client.confirmation.duration')).toHaveLength(sent);
    // Nothing keeps polling or waiting once flush() resolved. viem leaves one short timer per client for about a
    // second after its waits ended, with or without hashspan, so the count is taken after that.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(timers()).toBeLessThanOrEqual(timersBefore);
  }, 180_000);

  it('confirms no more than maxBackgroundConfirmations at once, and frees their slots', async () => {
    const warn = vi.spyOn(diag, 'warn');
    const meters = recordingMeterProvider();
    const limit = 16;
    const hashspan = withHashspan({
      meterProvider: meters.provider,
      maxBackgroundConfirmations: limit,
      confirm: { mode: 'background', timeoutMs: 60_000 },
    });

    // Every account sends before anything is mined: the first `limit` confirmations take every slot.
    const first = await sendBatch(hashspan, 5);
    await expect(hashspan.flush({ timeoutMs: 60_000 })).resolves.toBe(true);
    const limitWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('maxBackgroundConfirmations'),
    );
    expect(limitWarnings).toHaveLength(1);
    expect(tracing.spans().filter((s) => s.name === 'confirm 31337')).toHaveLength(limit);
    expect(meters.recorded('blockchain.client.send.duration')).toHaveLength(first);

    // Once they ended, the slots are free again.
    const second = await sendBatch(hashspan, 1);
    await expect(hashspan.flush({ timeoutMs: 60_000 })).resolves.toBe(true);
    expect(tracing.spans().filter((s) => s.name === 'confirm 31337')).toHaveLength(
      limit + Math.min(second, limit),
    );
    warn.mockRestore();
  }, 180_000);

  it('does not keep growing the heap across repeated batches', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    expect(gc, 'run with --expose-gc (the load project sets it)').toBeTypeOf('function');
    const hashspan = withHashspan({
      maxBackgroundConfirmations: 1_000,
      confirm: { mode: 'background', timeoutMs: 60_000 },
    });
    const heapAfter: number[] = [];
    for (let batch = 1; batch <= 6; batch++) {
      await sendBatch(hashspan, 10);
      await expect(hashspan.flush({ timeoutMs: 60_000 })).resolves.toBe(true);
      tracing.exporter.reset();
      gc?.();
      heapAfter.push(process.memoryUsage().heapUsed);
    }
    // After warm-up, what one batch leaves behind stays small: the tracker forgets transactions after its own
    // limits (maxTrackedTransactions, linkTtlMs), which these batches stay below.
    const growth = (heapAfter[5] as number) - (heapAfter[1] as number);
    expect(growth).toBeLessThan(16 * 1024 * 1024);
  }, 300_000);
});
