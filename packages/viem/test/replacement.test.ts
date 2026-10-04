import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const MINED = `0x${'cd'.repeat(32)}` as const;

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const minedReceipt = {
  transactionHash: MINED,
  status: 'success' as const,
  blockNumber: 124n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
};
const replacement = {
  reason: 'repriced' as const,
  replacedTransaction: { hash: HASH, to: TO },
  transaction: { hash: MINED, to: TO },
  transactionReceipt: minedReceipt,
};

/**
 * A client whose `waitForTransactionReceipt` reports a replacement like viem does: it calls `onReplaced`, then
 * resolves with the replacing receipt, and rejects if `onReplaced` throws.
 */
function replacingClient(options: { report?: boolean } = {}) {
  return createPublicClient({ chain: base, transport: mockTransport().transport })
    .extend(() => ({
      waitForTransactionReceipt: async (args: { onReplaced?: (r: unknown) => void }) => {
        if (options.report !== false) args.onReplaced?.(replacement);
        return minedReceipt;
      },
    }))
    .extend(withHashspan());
}

const confirmOf = (hash: string) =>
  tracing
    .spans()
    .find((s) => s.name === 'confirm 8453' && s.attributes['blockchain.tx.hash'] === hash);

/** Fails the test on any unhandled rejection raised while `run` executes. */
async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    // Unhandled rejections are reported once the microtask queue has drained; callers flush pending work.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  expect(rejections).toEqual([]);
}

describe('receipts with a malformed transaction hash', () => {
  for (const status of ['success', 'reverted'] as const) {
    it(`end the confirm span without an unhandled rejection (${status})`, async () => {
      vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const malformed = { ...minedReceipt, status, transactionHash: 42 };
      const client = createPublicClient({ chain: base, transport: mockTransport().transport })
        .extend(() => ({ waitForTransactionReceipt: async () => malformed }))
        .extend(withHashspan());

      await withoutUnhandledRejections(async () => {
        await expect(client.waitForTransactionReceipt({ hash: HASH })).resolves.toBe(malformed);
        await vi.waitFor(() => expect(confirmOf(HASH)).toBeDefined());
      });
      expect(confirmOf(HASH)?.attributes['error.type']).toBe('_OTHER');
      expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBeUndefined();
    });
  }

  it('end the confirm span without an unhandled rejection when viem reported the replacement', async () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const malformed = { ...minedReceipt, transactionHash: 42 };
    const client = createPublicClient({ chain: base, transport: mockTransport().transport })
      .extend(() => ({
        waitForTransactionReceipt: async (args: { onReplaced?: (r: unknown) => void }) => {
          args.onReplaced?.({ ...replacement, transactionReceipt: malformed });
          return malformed;
        },
      }))
      .extend(withHashspan());

    await withoutUnhandledRejections(async () => {
      await client.waitForTransactionReceipt({ hash: HASH });
      await vi.waitFor(() => expect(confirmOf(HASH)).toBeDefined());
    });
    expect(confirmOf(HASH)?.attributes['error.type']).toBe('_OTHER');
  });
});

describe('replaced transactions', () => {
  it("returns viem's result and attributes the receipt to the mined transaction", async () => {
    const onReplaced = vi.fn();
    const receipt = await replacingClient().waitForTransactionReceipt({ hash: HASH, onReplaced });

    expect(receipt).toBe(minedReceipt);
    expect(onReplaced).toHaveBeenCalledWith(replacement);
    await vi.waitFor(() => expect(confirmOf(MINED)).toBeDefined());
    expect(confirmOf(HASH)?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': MINED,
      'blockchain.tx.replacement.reason': 'repriced',
    });
    expect(confirmOf(HASH)?.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(confirmOf(MINED)?.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.fee': '42000',
    });
  });

  it("still rejects with the caller's error when its onReplaced throws, and records the replacement", async () => {
    const failure = new Error('callback failed');
    const wait = replacingClient().waitForTransactionReceipt({
      hash: HASH,
      onReplaced: () => {
        throw failure;
      },
    });

    await expect(wait).rejects.toBe(failure);
    await vi.waitFor(() => expect(confirmOf(MINED)).toBeDefined());
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBe('replaced');
    expect(confirmOf(HASH)?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirmOf(MINED)?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('records no receipt of another hash that the library did not report as a replacement', async () => {
    await expect(
      replacingClient({ report: false }).waitForTransactionReceipt({ hash: HASH }),
    ).resolves.toBe(minedReceipt);
    await vi.waitFor(() => expect(confirmOf(HASH)).toBeDefined());
    expect(confirmOf(HASH)?.attributes['error.type']).toBe('_OTHER');
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBeUndefined();
    expect(confirmOf(MINED)).toBeUndefined();
  });

  it('works without a caller onReplaced', async () => {
    await expect(replacingClient().waitForTransactionReceipt({ hash: HASH })).resolves.toBe(
      minedReceipt,
    );
    await vi.waitFor(() => expect(confirmOf(MINED)).toBeDefined());
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.reason']).toBe('repriced');
  });
});

describe('a receipt of another transaction from the endpoint', () => {
  // The node answers the receipt request for HASH with the receipt of MINED, which viem returns as is.
  const node = () => mockTransport({ receipt: { transactionHash: MINED } }).transport;
  const expectUnrecorded = () => {
    expect(confirmOf(HASH)?.attributes['error.type']).toBe('_OTHER');
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBeUndefined();
    expect(confirmOf(HASH)?.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(confirmOf(MINED)).toBeUndefined();
  };

  it("is not recorded on the caller's wait, which still returns it", async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node(),
      pollingInterval: 10,
    }).extend(hashspan);
    await expect(reader.waitForTransactionReceipt({ hash: HASH })).resolves.toMatchObject({
      transactionHash: MINED,
    });
    await expect(hashspan.flush()).resolves.toBe(true);
    expectUnrecorded();
  });

  it('is not recorded by background confirmation', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 1_000 } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: node(),
      pollingInterval: 10,
    }).extend(hashspan);
    await expect(wallet.sendTransaction({ to: TO })).resolves.toBe(HASH);
    await expect(hashspan.flush()).resolves.toBe(true);
    expectUnrecorded();
  });

  it('is not recorded by watch()', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: base, transport: node(), pollingInterval: 10 });
    const onReceipt = vi.fn();
    hashspan.watch(reader, { hash: HASH, timeoutMs: 1_000, onReceipt });
    await expect(hashspan.flush()).resolves.toBe(true);
    expectUnrecorded();
    // The caller's callback still gets what viem returned.
    await vi.waitFor(() =>
      expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: MINED })),
    );
  });
});
