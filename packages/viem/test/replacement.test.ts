import { SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, mockTransport, TO } from './mock-transport.js';
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

  it('records no reason when the library did not report the replacement', async () => {
    await replacingClient({ report: false }).waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() => expect(confirmOf(MINED)).toBeDefined());
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBe('replaced');
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.reason']).toBeUndefined();
  });

  it('works without a caller onReplaced', async () => {
    await expect(replacingClient().waitForTransactionReceipt({ hash: HASH })).resolves.toBe(
      minedReceipt,
    );
    await vi.waitFor(() => expect(confirmOf(MINED)).toBeDefined());
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.reason']).toBe('repriced');
  });
});
