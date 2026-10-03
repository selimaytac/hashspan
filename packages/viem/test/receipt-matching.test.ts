// Receipts at their edges: each test here fails for a change that records a wrong fee or revert reason, or attributes
// a receipt to the wrong transaction (found by mutation testing, issue #207).
import { createPublicClient, createWalletClient, encodeErrorResult, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const MINED = `0x${'cd'.repeat(32)}` as const;
const OTHER_CONTRACT = '0x3333333333333333333333333333333333333333' as const;
const ZERO_HASH = `0x${'00'.repeat(32)}`;

const customErrors = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'error InsufficientBalance(uint256 available, uint256 required)',
]);
const insufficient = encodeErrorResult({
  abi: customErrors,
  errorName: 'InsufficientBalance',
  args: [1n, 2n],
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const confirmOf = (hash: string) =>
  tracing
    .spans()
    .find((s) => s.name === 'confirm 8453' && s.attributes['blockchain.tx.hash'] === hash);
const receiptCalls = (calls: string[]) =>
  calls.filter((method) => method === 'eth_getTransactionReceipt').length;

describe('the revert reason of a replacing transaction', () => {
  const minedReverted = {
    transactionHash: MINED,
    status: 'reverted' as const,
    blockNumber: 124n,
    gasUsed: 21_000n,
    effectiveGasPrice: 2n,
  };

  /**
   * Sends `transfer` with the custom errors' ABI to `TO`, then waits on a client that reports a replacement from
   * `replacedTo` to `replacingTo` (unless `report` is false) and returns the reverted receipt of the replacing one.
   */
  async function revertReasonOfReplacing(
    replacedTo: string | null,
    replacingTo: string | null,
    report = true,
  ) {
    const { transport } = mockTransport({ callRevertData: insufficient });
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(hashspan);
    const reader = createPublicClient({ chain: base, transport })
      .extend(() => ({
        waitForTransactionReceipt: async (args: { onReplaced?: (r: unknown) => void }) => {
          if (report) {
            args.onReplaced?.({
              reason: 'repriced',
              replacedTransaction: { to: replacedTo },
              transaction: { to: replacingTo },
              transactionReceipt: minedReverted,
            });
          }
          return minedReverted;
        },
      }))
      .extend(hashspan);

    const hash = await wallet.writeContract({
      address: TO,
      abi: customErrors,
      functionName: 'transfer',
      args: [FROM, 5n],
    });
    await reader.waitForTransactionReceipt({ hash });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(confirmOf(hash)?.attributes['blockchain.tx.status']).toBe('replaced');
    expect(confirmOf(MINED)?.attributes['blockchain.tx.status']).toBe('reverted');
    return confirmOf(MINED)?.attributes['blockchain.tx.revert.reason'];
  }

  it("is decoded with the original call's ABI when it calls the same contract", async () => {
    await expect(revertReasonOfReplacing(TO, TO)).resolves.toBe('InsufficientBalance(1, 2)');
    tracing.exporter.reset();
    await expect(revertReasonOfReplacing(TO, TO.toUpperCase().replace('0X', '0x'))).resolves.toBe(
      'InsufficientBalance(1, 2)',
    );
  });

  it('is only the error selector when it calls another contract, or creates one', async () => {
    const cases: [string | null, string | null][] = [
      [TO, OTHER_CONTRACT],
      [TO, null],
      [null, TO],
    ];
    for (const [replacedTo, replacingTo] of cases) {
      tracing.exporter.reset();
      await expect(revertReasonOfReplacing(replacedTo, replacingTo)).resolves.toBe(
        insufficient.slice(0, 10),
      );
    }
  });

  it('is only the error selector when the library did not report the replacement', async () => {
    await expect(revertReasonOfReplacing(TO, TO, false)).resolves.toBe(insufficient.slice(0, 10));
  });
});

describe("a caller's wait that fails", () => {
  it('ends the confirm span as a failure, not a timeout', async () => {
    const failure = new Error('rpc down');
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport })
      .extend(() => ({
        waitForTransactionReceipt: async () => {
          throw failure;
        },
      }))
      .extend(hashspan);

    await expect(reader.waitForTransactionReceipt({ hash: HASH })).rejects.toBe(failure);
    await hashspan.flush();
    expect(confirmOf(HASH)?.attributes['error.type']).toBe('Error');
  });
});

describe('a preconfirmed receipt', () => {
  const PRECONFIRMED = { blockHash: ZERO_HASH, l1Fee: '0x1388' };
  const SEALED_FEE = (21_000n * 1_000_000_000n + 10_000n).toString();

  it("is read again at the client's polling interval until the sealed receipt comes", async () => {
    const node = mockTransport({
      receipt: { l1Fee: '0x2710' },
      receiptAt: (call) => (call <= 4 ? PRECONFIRMED : {}),
    });
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    });

    hashspan.watch(reader, { hash: HASH });
    // Well within the 1 s retry used without a polling interval: three retries take at least 3 s.
    await expect(hashspan.flush({ timeoutMs: 1_500 })).resolves.toBe(true);
    expect(confirmOf(HASH)?.attributes['blockchain.tx.fee']).toBe(SEALED_FEE);
  });

  it('is read again after 1 s when the polling interval is not a positive number', async () => {
    for (const pollingInterval of [0, -5, '10']) {
      const node = mockTransport({ receipt: PRECONFIRMED });
      const preconfirmed = {
        transactionHash: HASH,
        status: 'success' as const,
        blockNumber: 123n,
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
        blockHash: ZERO_HASH,
      };
      const hashspan = withHashspan();
      const reader = createPublicClient({
        chain: base,
        transport: node.transport,
        pollingInterval: pollingInterval as number,
      })
        .extend(() => ({ waitForTransactionReceipt: async () => preconfirmed }))
        .extend(hashspan);

      await reader.waitForTransactionReceipt({ hash: HASH });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(receiptCalls(node.calls)).toBeLessThanOrEqual(1);
      await hashspan.flush({ timeoutMs: 0 });
    }
  });

  it('is told apart from a receipt whose block hash only ends in zeros, or is not a string', async () => {
    for (const blockHash of [`${HASH}0x00`, [ZERO_HASH]]) {
      tracing.exporter.reset();
      const node = mockTransport({ receipt: { blockHash } });
      const hashspan = withHashspan();
      const reader = createPublicClient({
        chain: base,
        transport: node.transport,
        pollingInterval: 10,
      });

      hashspan.watch(reader, { hash: HASH });
      await expect(hashspan.flush()).resolves.toBe(true);
      expect(confirmOf(HASH)?.attributes['blockchain.tx.fee']).toBe('21000000000000');
      expect(receiptCalls(node.calls)).toBe(1);
    }
  });
});
