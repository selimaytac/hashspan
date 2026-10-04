// Receipts at their edges: each test here fails for a change that records a wrong fee or status, or reads a bundle
// receipt wrongly (found by mutation testing, issue #207).
import { diag } from '@opentelemetry/api';
import { encodeAbiParameters, encodeEventTopics, type Hex, parseAbi } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { userOperationReceiptFromBundle } from '../src/user-operation.js';
import { setupTracing, type TestTracing } from './tracing.js';

const HASH = `0x${'ab'.repeat(32)}` as const;
const OTHER_HASH = `0x${'cd'.repeat(32)}` as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OP_HASH = `0x${'01'.repeat(32)}` as const;
const BUNDLE = `0x${'ab'.repeat(32)}` as const;
const SMART = '0x5555555555555555555555555555555555555555';
const PAYMASTER = '0x7777777777777777777777777777777777777777';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const viemReceipt = {
  transactionHash: HASH,
  status: 'success',
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
  blockHash: `0x${'ef'.repeat(32)}`,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

type Wait = (options?: unknown) => Promise<unknown>;

/** The confirm span a network-scoped account's wait records, without a reader, when the SDK's wait returns `result`. */
async function confirmOf(result: unknown) {
  class EvmClient {
    async createAccount() {
      return {
        address: ACCOUNT,
        useNetwork: async (network: string) => ({
          address: ACCOUNT,
          network,
          waitForTransactionReceipt: async () => result,
        }),
      };
    }
  }
  const cdp = { evm: new EvmClient() };
  withHashspan(cdp as never);
  const account = (await cdp.evm.createAccount()) as unknown as {
    useNetwork: (n: string) => Promise<{ waitForTransactionReceipt: Wait }>;
  };
  const scoped = await account.useNetwork('base');
  await expect(scoped.waitForTransactionReceipt({ hash: HASH })).resolves.toBe(result);
  return tracing.spans().filter((s) => s.name === 'confirm 8453');
}

describe("a network-scoped account's receipt", () => {
  it('is recorded as reverted', async () => {
    const [confirm] = await confirmOf({ ...viemReceipt, status: 'reverted' });
    expect(confirm?.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'blockchain.tx.fee': '42000',
    });
    expect(confirm?.attributes['error.type']).toBe('reverted');
  });

  it('is not a receipt with another status, or with a block number or gas used that is no bigint', async () => {
    const odd = [
      { ...viemReceipt, status: 'pending' },
      { ...viemReceipt, blockNumber: 123 },
      { ...viemReceipt, gasUsed: '21000' },
    ];
    for (const result of odd) {
      tracing.exporter.reset();
      const [confirm] = await confirmOf(result);
      expect(confirm?.attributes['error.type']).toBe('TypeError');
      expect(confirm?.attributes['blockchain.tx.status']).toBeUndefined();
    }
  });

  it('is recorded without a fee when its effective gas price is no bigint', async () => {
    const error = vi.spyOn(diag, 'error');
    const [confirm] = await confirmOf({ ...viemReceipt, effectiveGasPrice: '0x2', l1Fee: '0x5' });
    expect(confirm?.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
    });
    expect(confirm?.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(confirm?.attributes['blockchain.tx.l1_fee']).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('is not recorded when it is of another hash that viem did not report as a replacement', async () => {
    const spans = await confirmOf({ ...viemReceipt, transactionHash: OTHER_HASH });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(spans[0]?.attributes['error.type']).toBe('_OTHER');
    expect(spans[0]?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(spans[0]?.attributes['blockchain.tx.fee']).toBeUndefined();
  });

  it('is sealed, with its fees, when its block hash only contains a zero hash or is not a string', async () => {
    for (const blockHash of [`${HASH}0x00`, [`0x${'00'.repeat(32)}`]]) {
      tracing.exporter.reset();
      const [confirm] = await confirmOf({ ...viemReceipt, blockHash });
      expect(confirm?.attributes['blockchain.tx.fee']).toBe('42000');
    }
  });
});

const EVENT_ABI = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

function userOperationLog(address: unknown = ENTRY_POINT) {
  return {
    address,
    topics: encodeEventTopics({
      abi: EVENT_ABI,
      eventName: 'UserOperationEvent',
      args: { userOpHash: OP_HASH, sender: SMART, paymaster: PAYMASTER },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [3n, true, 1_234_000n, 90_000n],
    ),
  };
}

describe('userOperationReceiptFromBundle', () => {
  it('leaves out a bundle hash or block number that is malformed', () => {
    for (const [transactionHash, blockNumber] of [
      [42, '0x10zz'],
      [[BUNDLE], 'x0x10'],
      [undefined, ['0x10']],
      [undefined, 'abc'],
    ]) {
      expect(
        userOperationReceiptFromBundle({ transactionHash, blockNumber }, OP_HASH, undefined),
      ).toEqual({ transactionHash: undefined, blockNumber: undefined });
    }
  });

  it('skips logs without the topics of an operation event', () => {
    const receipt = userOperationReceiptFromBundle(
      {
        transactionHash: BUNDLE,
        logs: [userOperationLog(), { topics: [] }, { topics: [`0x${'99'.repeat(32)}`] as Hex[] }],
      },
      OP_HASH,
      SMART,
    );
    expect(receipt).toMatchObject({ success: true, actualGasCost: 1_234_000n });
  });

  it('checksums an EntryPoint address given in any case, and leaves out one that is not a string', () => {
    const mixed = `0x${ENTRY_POINT.slice(2)
      .replace(/[a-f]/g, (c) => c.toUpperCase())
      .replace('E', 'e')}`;
    expect(
      userOperationReceiptFromBundle({ logs: [userOperationLog(mixed)] }, OP_HASH, SMART)
        .entryPoint,
    ).toBe(ENTRY_POINT);
    expect(
      userOperationReceiptFromBundle({ logs: [userOperationLog([ENTRY_POINT])] }, OP_HASH, SMART),
    ).toMatchObject({ entryPoint: undefined, success: true });
  });
});
