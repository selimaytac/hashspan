// The asset a fee was paid in (ADR 0028): `blockchain.tx.fee_asset` on the confirm span, under the address mode, and
// `blockchain.fee.denomination` `token` on the fee sample.
import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTxTracker,
  METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
  type ReceiptLike,
  type TxTrackerOptions,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 42220;
const HASH = `0x${'9f'.repeat(32)}`;
const REPLACING = `0x${'cd'.repeat(32)}`;
/** A fee currency in mixed letter case, as a caller may pass it. */
const FEE_CURRENCY = `0x${'aB'.repeat(20)}`;
const FEE_CURRENCY_LOWER = FEE_CURRENCY.toLowerCase();
const FEE_TOKEN = `0x${'20c0'.repeat(10)}`;
const OTHER_CURRENCY = `0x${'77'.repeat(20)}`;

const receipt: ReceiptLike = {
  status: 'success',
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 1_000_000_000n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

function recordingMeterProvider() {
  const recorded = new Map<string, { value: number; attributes: Attributes }[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return {
          record: (value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push({ value, attributes });
          },
        };
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

function setup(options: TxTrackerOptions = {}) {
  const meters = recordingMeterProvider();
  const tracker = createTxTracker({ meterProvider: meters.provider, ...options });
  const confirm = (hash = HASH) =>
    tracing
      .spans()
      .find((s) => s.name === `confirm ${CHAIN_ID}` && s.attributes['blockchain.tx.hash'] === hash);
  const denominations = () =>
    meters
      .recorded(METRIC_BLOCKCHAIN_CLIENT_FEE)
      .map(({ attributes }) => attributes['blockchain.fee.denomination']);
  return { tracker, meters, confirm, denominations };
}

describe('the asset a fee was paid in', () => {
  it("records the send's fee asset, lower-cased, on the confirm span and marks the fee sample", () => {
    const { tracker, confirm, denominations, meters } = setup();
    const send = tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY });
    send.end({ hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);

    expect(confirm()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
    expect(denominations()).toEqual(['token']);
    // The send span records none: the asset belongs with the receipt's fee.
    const sent = tracing.spans().find((s) => s.name === `send ${CHAIN_ID}`);
    expect(sent?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    // Only the fee sample carries the marker.
    expect(
      meters
        .recorded(METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION)
        .some(({ attributes }) => 'blockchain.fee.denomination' in attributes),
    ).toBe(false);
  });

  it('records neither for a fee in the native currency', () => {
    const { tracker, confirm, denominations } = setup();
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirm()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual([undefined]);
  });

  it("takes the receipt's fee asset over the send's", () => {
    const { tracker, confirm, denominations } = setup();
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, feeAsset: FEE_TOKEN.toUpperCase().replace('0X', '0x') });
    expect(confirm()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_TOKEN);
    expect(denominations()).toEqual(['token']);
  });

  it('records it from the receipt alone, as a confirmation without a send does', () => {
    const { tracker, confirm, denominations } = setup();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, feeAsset: FEE_TOKEN });
    expect(confirm()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_TOKEN);
    expect(denominations()).toEqual(['token']);
  });

  it('records it only with the gas price, like the fee', () => {
    const { tracker, confirm, denominations } = setup();
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, effectiveGasPrice: undefined, feeAsset: FEE_TOKEN });
    expect(confirm()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(confirm()?.attributes).not.toHaveProperty('blockchain.tx.fee');
    expect(denominations()).toEqual([]);
  });

  it.each([
    ['too short', `0x${'ab'.repeat(19)}`],
    ['not hex', `0x${'zz'.repeat(20)}`],
    ['without 0x', 'ab'.repeat(20)],
    ['with a trailing newline', `${FEE_CURRENCY}\n`],
    ['a number', 42],
    ['an object', { toString: () => FEE_CURRENCY }],
  ])('drops a fee asset that is %s, from the send and the receipt', (_name, value) => {
    const { tracker, confirm, denominations } = setup();
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: value as never }).end({ hash: HASH });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, feeAsset: value as never });
    expect(confirm()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(confirm()?.attributes['blockchain.tx.fee']).toBe('21000000000000');
    expect(denominations()).toEqual([undefined]);
  });

  it("keeps the send's validated string, not the caller's input object", () => {
    const { tracker, confirm } = setup();
    const input = { chainId: CHAIN_ID, feeAsset: FEE_CURRENCY };
    tracker.startSend(input).end({ hash: HASH });
    input.feeAsset = OTHER_CURRENCY;
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirm()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
  });

  it('does not run a getter on the receipt', () => {
    const { tracker, confirm } = setup();
    const read = vi.fn(() => FEE_TOKEN);
    const withGetter = Object.defineProperty({ ...receipt }, 'feeAsset', {
      get: read,
      enumerable: true,
    });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(withGetter);
    expect(read).not.toHaveBeenCalled();
    expect(confirm()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
  });

  it.each([
    ['off', undefined],
    ['hashed', /^sha256:[0-9a-f]{32}$/],
  ] as const)(
    "follows the address mode '%s', and marks the sample all the same",
    (address, expected) => {
      const { tracker, confirm, denominations } = setup({ address });
      tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      const recorded = confirm()?.attributes['blockchain.tx.fee_asset'];
      if (expected === undefined) expect(recorded).toBeUndefined();
      else expect(recorded).toMatch(expected);
      expect(JSON.stringify(confirm()?.attributes)).not.toContain('abab');
      expect(denominations()).toEqual(['token']);
    },
  );

  it('drops it when the redact hook fails, as it does every address', () => {
    const { tracker, confirm, denominations } = setup({
      redact: () => {
        throw new Error('redact failed');
      },
    });
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirm()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(confirm()?.attributes['blockchain.tx.status']).toBe('success');
    // The metric is not redacted: the marker is a constant, never the address.
    expect(denominations()).toEqual(['token']);
  });

  it("gives a replacing transaction its own asset, never the replaced one's", () => {
    const { tracker, confirm, denominations } = setup();
    // The replaced transaction paid in a fee currency; the replacing one names none.
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: REPLACING, replacementReason: 'repriced' });
    expect(confirm(REPLACING)?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(confirm(HASH)?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual([undefined]);
  });

  it('records the asset the replacing transaction names, from its receipt or its own send', () => {
    const { tracker, confirm, denominations } = setup();
    const second = `0x${'12'.repeat(32)}`;
    const secondReplacing = `0x${'34'.repeat(32)}`;
    // As viem reports it: the replacing transaction's fee currency on its receipt.
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: REPLACING, feeAsset: OTHER_CURRENCY });
    // Sent through the tracker itself.
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: second });
    tracker
      .startSend({ chainId: CHAIN_ID, feeAsset: OTHER_CURRENCY })
      .end({ hash: secondReplacing });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: second })
      .end({ ...receipt, transactionHash: secondReplacing });

    expect(confirm(REPLACING)?.attributes['blockchain.tx.fee_asset']).toBe(OTHER_CURRENCY);
    expect(confirm(secondReplacing)?.attributes['blockchain.tx.fee_asset']).toBe(OTHER_CURRENCY);
    expect(denominations()).toEqual(['token', 'token']);
  });

  it('marks a fee sample that another party paid in a token with both attributes', () => {
    const { tracker, meters } = setup();
    const payment = tracker.startPayment({ chainId: CHAIN_ID, protocol: 'x402', amount: 1n });
    payment.link(HASH);
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, feeAsset: FEE_TOKEN });
    payment.end({ status: 'settled', hash: HASH });
    const [sample] = meters.recorded(METRIC_BLOCKCHAIN_CLIENT_FEE);
    expect(sample?.attributes['blockchain.fee.payer']).toBe('facilitator');
    expect(sample?.attributes['blockchain.fee.denomination']).toBe('token');
  });

  it('is recorded by a confirmation on the same tracker that starts outside the send, as background confirmation does', async () => {
    const { tracker, confirm } = setup();
    tracker.startSend({ chainId: CHAIN_ID, feeAsset: FEE_CURRENCY }).end({ hash: HASH });
    await new Promise((resolve) => setTimeout(resolve, 1));
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirm()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
    // Linked to the send it got the asset from.
    expect(confirm()?.links).toHaveLength(1);
  });
});
