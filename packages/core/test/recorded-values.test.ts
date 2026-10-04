// What the tracker does with a value that fails validation or crosses a bound (ADR 0025 rules 3 and 4): one test per
// behaviour, next to the hostile-input table that tries every hostile value.
import { diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker, type ReceiptLike } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'9f'.repeat(32)}`;
const ADDRESS = `0x${'22'.repeat(20)}`;
const receipt: ReceiptLike = {
  status: 'success',
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
  vi.spyOn(diag, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const attributesOf = () => tracing.spans()[0]?.attributes ?? {};

describe('chain ids', () => {
  it.each([0, -1, 1.5, Number.NaN, 2 ** 53, '8453', 8453n, undefined])(
    'records no span for the chain id %s',
    (chainId) => {
      const tracker = createTxTracker();
      tracker.startSend({ chainId: chainId as never }).end({ hash: HASH });
      tracker.startConfirm({ chainId: chainId as never, hash: HASH }).end(receipt);
      tracker
        .startPayment({ chainId: chainId as never, protocol: 'x402' })
        .end({ status: 'settled' });
      tracker.startUserOperationSend({ chainId: chainId as never }).end({ userOpHash: HASH });
      tracker.startCallBatchSend({ chainId: chainId as never }).end({ id: '0x1' });
      expect(tracing.spans()).toEqual([]);
    },
  );
});

describe('send inputs', () => {
  it('records valid values as they were recorded before', () => {
    createTxTracker()
      .startSend({
        chainId: CHAIN_ID,
        from: ADDRESS,
        to: ADDRESS,
        value: 10n ** 18n,
        nonce: 7,
        functionName: 'transfer',
        functionSelector: '0xa9059cbb',
      })
      .end({ hash: HASH });
    expect(attributesOf()).toMatchObject({
      'blockchain.tx.from': ADDRESS,
      'blockchain.tx.to': ADDRESS,
      'blockchain.tx.value': '1000000000000000000',
      'blockchain.tx.nonce': 7,
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
      'blockchain.tx.hash': HASH,
    });
  });

  it('records none of them when they are malformed', () => {
    createTxTracker()
      .startSend({
        chainId: CHAIN_ID,
        from: `${ADDRESS}00`,
        to: 'ens.eth',
        value: -1n,
        nonce: -1,
        functionName: 'transfer(address,uint256)',
        functionSelector: '0xa9059cbbzz',
      })
      .end({ hash: HASH.slice(0, 40) });
    const recorded = Object.keys(attributesOf()).filter(
      (key) => key.startsWith('blockchain.tx.') || key.startsWith('blockchain.contract.'),
    );
    expect(recorded).toEqual([]);
  });

  it('records no confirm span for a hash that is not one', () => {
    createTxTracker().startConfirm({ chainId: CHAIN_ID, hash: 'not-a-hash' }).end(receipt);
    expect(tracing.spans()).toEqual([]);
  });
});

describe('receipts', () => {
  it('records no fee when the L1 fee cannot be read, rather than one without it', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, l1Fee: '0x10' as never });
    expect(attributesOf()['blockchain.tx.fee']).toBeUndefined();
    expect(attributesOf()['blockchain.tx.l1_fee']).toBeUndefined();
    expect(attributesOf()['blockchain.tx.effective_gas_price']).toBe('2');
  });

  it('records no fee larger than 256 bits', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, effectiveGasPrice: 2n ** 255n });
    expect(attributesOf()['blockchain.tx.effective_gas_price']).toBe((2n ** 255n).toString());
    expect(attributesOf()['blockchain.tx.fee']).toBeUndefined();
  });

  it('keeps at most 1024 characters of a revert reason, and one an adapter cut as it is', () => {
    const tracker = createTxTracker();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, status: 'reverted', revertReason: 'x'.repeat(5000) });
    const cut = `${'y'.repeat(1023)}...`;
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: `0x${'aa'.repeat(32)}` })
      .end({ ...receipt, status: 'reverted', revertReason: cut });
    const [first, second] = tracing.spans();
    expect(first?.attributes['blockchain.tx.revert.reason']).toBe(`${'x'.repeat(1024)}...`);
    expect(second?.attributes['blockchain.tx.revert.reason']).toBe(cut);
  });
});

describe('error names', () => {
  it.each([
    ['a name with spaces', 'Some Error'],
    ['a name longer than 64 characters', `${'X'.repeat(60)}Error`],
    ['an empty name', ''],
  ])('records _OTHER for %s', (_label, name) => {
    const error = new Error('boom');
    error.name = name;
    createTxTracker().startSend({ chainId: CHAIN_ID }).fail(error);
    const span = tracing.spans()[0];
    expect(span?.attributes['error.type']).toBe('_OTHER');
    expect(span?.events[0]?.attributes?.['exception.type']).toBe('_OTHER');
  });

  it('keeps a class name that is a short identifier', () => {
    const error = new Error('boom');
    error.name = 'TransactionExecutionError';
    createTxTracker().startSend({ chainId: CHAIN_ID }).fail(error);
    expect(attributesOf()['error.type']).toBe('TransactionExecutionError');
  });
});

describe('call batch lists', () => {
  it('links at most 64 transaction hashes of a call batch send', () => {
    const hashes = Array.from({ length: 100 }, (_, i) => `0x${i.toString(16).padStart(64, '1')}`);
    const tracker = createTxTracker();
    tracker.startCallBatchSend({ chainId: CHAIN_ID }).end({ id: '0x1', transactionHashes: hashes });
    for (const hash of [hashes[63], hashes[64]] as string[]) {
      tracker.startConfirm({ chainId: CHAIN_ID, hash }).end(receipt);
    }
    const confirms = tracing.spans().filter((span) => span.name.startsWith('confirm'));
    expect(confirms.map((span) => span.links.length)).toEqual([1, 0]);
  });
});

describe('options', () => {
  it.each([null, 'raw', 1])('takes %s as no options', (options) => {
    createTxTracker(options as never)
      .startSend({ chainId: CHAIN_ID })
      .end({ hash: HASH });
    expect(attributesOf()['blockchain.tx.hash']).toBe(HASH);
  });

  it.each([0, -1, Number.NaN, '600000', 1.5])(
    'uses the default bounds for a linkTtlMs or maxTrackedTransactions of %s',
    (bound) => {
      const tracker = createTxTracker({
        linkTtlMs: bound as never,
        maxTrackedTransactions: bound as never,
      });
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      const confirm = tracing.spans().find((span) => span.name.startsWith('confirm'));
      expect(confirm?.links).toHaveLength(1);
    },
  );

  it('uses the default for an option that cannot be read', () => {
    const options = {};
    Object.defineProperty(options, 'linkTtlMs', {
      get: () => {
        throw new Error('getter');
      },
    });
    createTxTracker(options).startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
    expect(attributesOf()['blockchain.tx.hash']).toBe(HASH);
  });
});
