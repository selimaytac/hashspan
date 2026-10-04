// Replacements on a network-scoped account's wait without a reader: the SDK waits with its own viem client, which
// reports a replacement through `onReplaced` (docs/adr/0008-replaced-transactions.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const HASH = `0x${'ab'.repeat(32)}` as const;
const MINED = `0x${'cd'.repeat(32)}` as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111';

const minedReceipt = {
  transactionHash: MINED,
  status: 'success',
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
  blockHash: `0x${'ef'.repeat(32)}`,
};
const replacement = {
  reason: 'repriced',
  replacedTransaction: { hash: HASH },
  transaction: { hash: MINED },
  transactionReceipt: minedReceipt,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

type Wait = (options: unknown) => Promise<unknown>;

/**
 * A network-scoped account, without a reader, whose SDK wait is `sdkWait`; it returns the traced
 * `waitForTransactionReceipt` and the flush of the `withHashspan()` call.
 */
async function scopedAccount(sdkWait: Wait) {
  class EvmClient {
    async createAccount() {
      return {
        address: ACCOUNT,
        useNetwork: async (network: string) => ({
          address: ACCOUNT,
          network,
          waitForTransactionReceipt: sdkWait,
        }),
      };
    }
  }
  const cdp = { evm: new EvmClient() };
  const hashspan = withHashspan(cdp as never);
  const account = (await cdp.evm.createAccount()) as unknown as {
    useNetwork: (n: string) => Promise<{ waitForTransactionReceipt: Wait }>;
  };
  const scoped = await account.useNetwork('base');
  return { wait: scoped.waitForTransactionReceipt, flush: () => hashspan.flush() };
}

/** Waits like viem: reports the replacement through `onReplaced`, rejects if that throws, then resolves. */
const replacingWait =
  (seen: unknown[]): Wait =>
  async (options) => {
    seen.push(options);
    (options as { onReplaced?: (r: unknown) => void }).onReplaced?.(replacement);
    return minedReceipt;
  };

const confirmOf = (hash: string) =>
  tracing
    .spans()
    .find((s) => s.name === 'confirm 8453' && s.attributes['blockchain.tx.hash'] === hash);

function expectReplaced() {
  expect(confirmOf(HASH)?.attributes).toMatchObject({
    'blockchain.tx.status': 'replaced',
    'blockchain.tx.replacement.hash': MINED,
    'blockchain.tx.replacement.reason': 'repriced',
  });
  expect(confirmOf(MINED)?.attributes['blockchain.tx.fee']).toBe('42000');
}

describe("a network-scoped account's wait without a reader", () => {
  it("records a replacement viem reported, and calls the caller's onReplaced", async () => {
    const seen: unknown[] = [];
    const { wait, flush } = await scopedAccount(replacingWait(seen));
    const onReplaced = vi.fn();
    const options = { hash: HASH, onReplaced };

    await expect(wait(options)).resolves.toBe(minedReceipt);
    await expect(flush()).resolves.toBe(true);

    expect(onReplaced).toHaveBeenCalledWith(replacement);
    // The caller's options are not changed; the SDK gets an object that reads like them.
    expect(options.onReplaced).toBe(onReplaced);
    expect(seen[0]).not.toBe(options);
    expect((seen[0] as { hash: string }).hash).toBe(HASH);
    expectReplaced();
  });

  it('passes { transactionHash } on as { hash, onReplaced }, and records the replacement', async () => {
    const seen: unknown[] = [];
    const { wait, flush } = await scopedAccount(replacingWait(seen));

    await expect(wait({ transactionHash: HASH })).resolves.toBe(minedReceipt);
    await expect(flush()).resolves.toBe(true);

    expect(Object.keys(seen[0] as object).sort()).toEqual(['hash', 'onReplaced']);
    expect((seen[0] as { hash: string }).hash).toBe(HASH);
    expectReplaced();
  });

  it("rejects with the caller's error when its onReplaced throws, and records the replacement", async () => {
    const failure = new Error('callback failed');
    const { wait, flush } = await scopedAccount(replacingWait([]));

    await expect(
      wait({
        hash: HASH,
        onReplaced: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await expect(flush()).resolves.toBe(true);

    expectReplaced();
  });

  it('records no receipt of another hash that viem did not report', async () => {
    const { wait, flush } = await scopedAccount(async () => minedReceipt);

    await expect(wait({ hash: HASH })).resolves.toBe(minedReceipt);
    await expect(flush()).resolves.toBe(true);

    expect(confirmOf(HASH)?.attributes['error.type']).toBe('_OTHER');
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirmOf(MINED)).toBeUndefined();
  });

  it('passes the call on untraced, with the same options, when onReplaced is an accessor', async () => {
    const seen: unknown[] = [];
    const { wait, flush } = await scopedAccount(async (options) => {
      seen.push(options);
      return minedReceipt;
    });
    const getter = vi.fn(() => undefined);
    const options = Object.defineProperty({ hash: HASH }, 'onReplaced', { get: getter });

    await expect(wait(options)).resolves.toBe(minedReceipt);
    await expect(flush()).resolves.toBe(true);

    expect(seen[0]).toBe(options);
    expect(getter).not.toHaveBeenCalled();
    expect(confirmOf(HASH)).toBeUndefined();
  });
});
