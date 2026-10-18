// Payments whose settlement transaction the payer sends itself, as with MPP (ADR 0029): `PaymentInput.sender`,
// `hash` and `mpp`, and the tracker member that tells an adapter the core reads them (ADR 0014).
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTxTracker,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
  type PaymentInput,
  type TxTracker,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';
import { recordingMeterProvider } from './hostile.js';

const CHAIN_ID = 4217;
const HASH = `0x${'9f'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const PAYER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const CURRENCY = '0x20c0000000000000000000000000000000000001';
const PAYMENT_SPAN = `payment ${CHAIN_ID}`;
const CONFIRM_SPAN = `confirm ${CHAIN_ID}`;
const SEND_SPAN = `send ${CHAIN_ID}`;
const RECEIPT = { status: 'success', blockNumber: 1n, gasUsed: 21_000n, effectiveGasPrice: 2n };

const mppPayment: PaymentInput = {
  chainId: CHAIN_ID,
  protocol: 'mpp',
  sender: 'payer',
  payer: PAYER,
  recipient: RECIPIENT,
  asset: CURRENCY,
  amount: '1000',
  mpp: {
    method: 'tempo',
    intent: 'charge',
    mode: 'pull',
    challengeId: 'qB3wVm6v2Jt4Xk9rLp0sZ_aQ-1yHc8NdEfGhIjKlMnO',
    resource: 'https://api.example.com/weather?city=berlin',
  },
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const feePayers = (meters: ReturnType<typeof recordingMeterProvider>) =>
  meters
    .samples()
    .filter(({ name }) => name === METRIC_BLOCKCHAIN_CLIENT_FEE)
    .map(({ attributes }) => attributes['blockchain.fee.payer']);

describe('a payment the payer settles', () => {
  it('tells adapters that the tracker reads sender, hash and mpp (ADR 0014)', () => {
    const tracker: TxTracker = createTxTracker();
    expect(tracker.paymentSenders).toEqual(['facilitator', 'payer']);
    expect(Object.isFrozen(tracker.paymentSenders)).toBe(true);
  });

  it('records the protocol mpp and the MPP fields, with the resource per the paymentResource mode', () => {
    createTxTracker().startPayment(mppPayment).end({ status: 'settled', hash: HASH });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes).toMatchObject({
      'blockchain.payment.protocol': 'mpp',
      'mpp.method': 'tempo',
      'mpp.intent': 'charge',
      'mpp.mode': 'pull',
      'mpp.challenge.id': 'qB3wVm6v2Jt4Xk9rLp0sZ_aQ-1yHc8NdEfGhIjKlMnO',
      'mpp.resource': 'https://api.example.com',
    });
    expect(span.attributes['x402.resource']).toBeUndefined();
    expect(span.attributes['x402.scheme']).toBeUndefined();
  });

  it('records the path of the resource with paymentResource path, and none with off', () => {
    createTxTracker({ paymentResource: 'path' }).startPayment(mppPayment).timeout();
    createTxTracker({ paymentResource: 'off' }).startPayment(mppPayment).timeout();
    const [path, off] = tracing.spans();
    expect(path?.attributes['mpp.resource']).toBe('https://api.example.com/weather');
    expect(off?.attributes['mpp.resource']).toBeUndefined();
  });

  it.each([
    ['a mode that is not push or pull', { mode: 'proof' }, 'mpp.mode'],
    ['a method that is not a short identifier', { method: 'tem po' }, 'mpp.method'],
    ['an intent that is not a short identifier', { intent: 'x'.repeat(65) }, 'mpp.intent'],
    [
      'a challenge id with a character ids do not use',
      { challengeId: 'abc def' },
      'mpp.challenge.id',
    ],
    [
      'a challenge id longer than 128 characters',
      { challengeId: 'a'.repeat(129) },
      'mpp.challenge.id',
    ],
    ['an empty challenge id', { challengeId: '' }, 'mpp.challenge.id'],
    ['a challenge id that is not text', { challengeId: 42 }, 'mpp.challenge.id'],
  ])('does not record %s', (_name, mpp, key) => {
    createTxTracker()
      .startPayment({ ...mppPayment, mpp: { ...mppPayment.mpp, ...mpp } as never })
      .timeout();
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes[key]).toBeUndefined();
    expect(span.attributes['blockchain.payment.protocol']).toBe('mpp');
  });

  it('records a challenge id of exactly 128 characters', () => {
    const challengeId = `${'a'.repeat(64)}${'Z9_-.~'.repeat(10)}${'b'.repeat(4)}`;
    expect(challengeId).toHaveLength(128);
    createTxTracker()
      .startPayment({ ...mppPayment, mpp: { challengeId } })
      .timeout();
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['mpp.challenge.id']).toBe(challengeId);
  });

  it('records no challenge id that holds an address when the address mode hides addresses', () => {
    const address = '2222222222222222222222222222222222222222';
    const ids = [address, `0x${address}`, `id-${address.toUpperCase()}-x`];
    for (const mode of ['raw', 'hashed', 'off'] as const) {
      for (const challengeId of ids) {
        createTxTracker({ address: mode })
          .startPayment({ ...mppPayment, mpp: { challengeId } })
          .timeout();
      }
    }
    const recorded = tracing.spans().map((span) => span.attributes['mpp.challenge.id']);
    expect(recorded).toEqual([
      ...ids,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('records the hash the payer knows when the span starts, so a timeout keeps it', () => {
    const tracker = createTxTracker();
    tracker.startPayment({ ...mppPayment, hash: HASH }).timeout();
    tracker.startPayment({ ...mppPayment, hash: OTHER_HASH }).fail(new Error('declined'));
    const [timedOut, failed] = tracing.spans();
    expect(timedOut?.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(timedOut?.attributes['error.type']).toBe('timeout');
    expect(timedOut?.attributes['blockchain.payment.status']).toBeUndefined();
    expect(failed?.attributes['blockchain.tx.hash']).toBe(OTHER_HASH);
  });

  it('records no hash at the start that is not one', () => {
    createTxTracker()
      .startPayment({ ...mppPayment, hash: HASH.slice(0, 40) })
      .timeout();
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.tx.hash']).toBeUndefined();
  });

  it("keeps the payer's own hash over a different one the settlement reports, and does not link that one", () => {
    const tracker = createTxTracker();
    tracker
      .startPayment({ ...mppPayment, hash: HASH })
      .end({ status: 'settled', hash: OTHER_HASH, verified: false });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: OTHER_HASH }).end(RECEIPT as never);
    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(payment.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(payment.attributes['blockchain.payment.verified']).toBe(false);
    expect(tracing.spanNamed(CONFIRM_SPAN).links).toEqual([]);
  });

  it('links the confirm span of a hash known at the start to the payment span', () => {
    const tracker = createTxTracker();
    const handle = tracker.startPayment({ ...mppPayment, hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(RECEIPT as never);
    handle.end({ status: 'settled', hash: HASH });
    const payment = tracing.spanNamed(PAYMENT_SPAN);
    expect(tracing.spanNamed(CONFIRM_SPAN).links.map((l) => l.context.spanId)).toEqual([
      payment.spanContext().spanId,
    ]);
    // No send span of the hash: the payment span links to nothing.
    expect(payment.links).toEqual([]);
  });

  it('starts with a link to the send span of a hash this tracker sent, which keeps the confirm link', () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(RECEIPT as never);
    tracker.startPayment({ ...mppPayment, hash: HASH }).end({ status: 'settled', hash: HASH });
    const send = tracing.spanNamed(SEND_SPAN).spanContext().spanId;
    expect(tracing.spanNamed(PAYMENT_SPAN).links.map((l) => l.context.spanId)).toEqual([send]);
    expect(tracing.spanNamed(CONFIRM_SPAN).links.map((l) => l.context.spanId)).toEqual([send]);
  });

  it('does not link to another payment span of the same hash', () => {
    const tracker = createTxTracker();
    tracker.startPayment({ ...mppPayment, hash: HASH }).end({ status: 'settled', hash: HASH });
    tracker.startPayment({ ...mppPayment, hash: HASH }).end({ status: 'settled', hash: HASH });
    expect(tracing.spans().map((span) => span.links)).toEqual([[], []]);
  });

  it('labels the fee of its settlement sponsor only when the receipt names another fee payer', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    // The payer paid its fee (push, or an unsponsored pull).
    const own = tracker.startPayment({ ...mppPayment, hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(RECEIPT as never);
    own.end({ status: 'settled', hash: HASH });
    // A sponsored pull: the server paid the fee, and the hash comes with the settlement.
    const sponsored = tracker.startPayment(mppPayment);
    sponsored.link(OTHER_HASH);
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: OTHER_HASH })
      .end({ ...RECEIPT, sponsored: true } as never);
    sponsored.end({ status: 'settled', hash: OTHER_HASH });
    // An x402 payment, settled by its facilitator, as before.
    const x402 = tracker.startPayment({ chainId: CHAIN_ID, protocol: 'x402', amount: 1n });
    const third = `0x${'ef'.repeat(32)}`;
    x402.link(third);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: third }).end(RECEIPT as never);
    x402.end({ status: 'settled', hash: third });
    expect(feePayers(meters)).toEqual([undefined, 'sponsor', 'facilitator']);
  });

  it('reads any sender other than payer as facilitator', () => {
    const meters = recordingMeterProvider();
    const tracker = createTxTracker({ meterProvider: meters.provider });
    for (const [index, sender] of ['facilitator', 'PAYER', 1, undefined].entries()) {
      const hash = `0x${String(index + 1)
        .padStart(2, '0')
        .repeat(32)}`;
      const payment = tracker.startPayment({ ...mppPayment, sender: sender as never });
      payment.link(hash);
      tracker.startConfirm({ chainId: CHAIN_ID, hash }).end(RECEIPT as never);
      payment.end({ status: 'settled', hash });
    }
    expect(feePayers(meters)).toEqual(['facilitator', 'facilitator', 'facilitator', 'facilitator']);
  });

  it('keeps the hash, the protocol and the payment status when the redaction hook fails', () => {
    createTxTracker({
      redact: () => {
        throw new Error('redaction failed');
      },
    })
      .startPayment({ ...mppPayment, hash: HASH })
      .end({ status: 'settled', hash: HASH });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(span.attributes['blockchain.payment.protocol']).toBe('mpp');
    expect(span.attributes['mpp.challenge.id']).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});
