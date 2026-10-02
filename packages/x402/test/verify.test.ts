import { createTxTracker, type TxTracker } from '@hashspan/core';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbi,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTransport, HASH as RECEIPT_HASH } from '../../viem/test/mock-transport.js';
import { withHashspan } from '../src/index.js';
import { ASSET, PAY_TO, PAYER, paymentRequired } from './fake-x402.js';
import { setupTracing, type TestTracing } from './tracing.js';

const NONCE = `0x${'5a'.repeat(32)}` as const;
const OTHER = '0x4444444444444444444444444444444444444444';
const PAYMENT_SPAN = 'payment 84532';
const events = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** A log of `address`, as a node returns it. */
function rawLog(address: string, topics: Hex[], data: Hex, logIndex: number) {
  return {
    address,
    topics,
    data,
    blockNumber: '0x7b',
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionHash: RECEIPT_HASH,
    transactionIndex: '0x0',
    logIndex: `0x${logIndex.toString(16)}`,
    removed: false,
  };
}
const authorizationUsed = (authorizer: string, nonce: Hex, address = ASSET, index = 0) =>
  rawLog(
    address,
    encodeEventTopics({
      abi: events,
      eventName: 'AuthorizationUsed',
      args: { authorizer: authorizer as Hex, nonce },
    }) as Hex[],
    '0x',
    index,
  );
const transfer = (from: string, to: string, value: bigint, address = ASSET, index = 1) =>
  rawLog(
    address,
    encodeEventTopics({
      abi: events,
      eventName: 'Transfer',
      args: { from: from as Hex, to: to as Hex },
    }) as Hex[],
    encodeAbiParameters([{ type: 'uint256' }], [value]),
    index,
  );

/** The logs of a settlement of the default payment: 10000 from the payer to the recipient. */
const matching = () => [authorizationUsed(PAYER, NONCE), transfer(PAYER, PAY_TO, 10_000n)];

const readerWith = (receipt: Record<string, unknown> | null) =>
  createPublicClient({
    chain: baseSepolia,
    transport: mockTransport({ chainIdHex: '0x14a34', receipt }).transport,
    pollingInterval: 10,
  });

/** Stands in for an x402Client: runs one payment through the hooks registered on it, as the SDK would. */
function capturingClient() {
  const hooks: Record<string, (ctx: unknown) => unknown> = {};
  const register = (name: string) =>
    function (this: unknown, hook: (ctx: unknown) => unknown) {
      hooks[name] = hook;
      return this;
    };
  const client = {
    onBeforePaymentCreation: register('before'),
    onAfterPaymentCreation: register('after'),
    onPaymentCreationFailure: register('failure'),
    onPaymentResponse: register('response'),
  };
  const pay = (
    signed: unknown = { authorization: { from: PAYER, nonce: NONCE } },
    options: { requirements?: Parameters<typeof paymentRequired>[0]; settlement?: object } = {},
  ) => {
    const required = paymentRequired(options.requirements);
    const selectedRequirements = required.accepts[0];
    const paymentPayload = { x402Version: 2, payload: signed };
    hooks.before?.({ paymentRequired: required, selectedRequirements });
    hooks.after?.({ paymentRequired: required, selectedRequirements, paymentPayload });
    hooks.response?.({
      paymentPayload,
      requirements: selectedRequirements,
      settleResponse: {
        success: true,
        transaction: RECEIPT_HASH,
        network: 'eip155:84532',
        ...options.settlement,
      },
    });
  };
  return { client, pay };
}

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** Pays once through a client traced with `reader`, and returns the payment span once everything is flushed. */
async function paid(
  reader: ReturnType<typeof readerWith> | undefined,
  signed?: unknown,
  options?: Parameters<ReturnType<typeof capturingClient>['pay']>[1],
) {
  const { client, pay } = capturingClient();
  const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 200 });
  pay(signed, options);
  await hashspan.flush();
  return tracing.spanNamed(PAYMENT_SPAN);
}

describe('checking that the settlement transaction carries the payment', () => {
  it('records true when the receipt has its authorization and transfer, and keeps the span linked', async () => {
    const span = await paid(readerWith({ logs: matching() }));
    expect(span.attributes['blockchain.payment.verified']).toBe(true);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.links.map((l) => l.context.spanId)).toEqual([span.spanContext().spanId]);
  });

  it('records true for a receipt that also carries unrelated transfers', async () => {
    const logs = [
      transfer(OTHER, PAY_TO, 5n, ASSET, 0),
      authorizationUsed(PAYER, NONCE, ASSET, 1),
      transfer(PAYER, PAY_TO, 10_000n, ASSET, 2),
    ];
    expect((await paid(readerWith({ logs }))).attributes['blockchain.payment.verified']).toBe(true);
  });

  it.each([
    ['another amount', [authorizationUsed(PAYER, NONCE), transfer(PAYER, PAY_TO, 9_999n)]],
    ['another recipient', [authorizationUsed(PAYER, NONCE), transfer(PAYER, OTHER, 10_000n)]],
    ['another payer', [authorizationUsed(OTHER, NONCE), transfer(OTHER, PAY_TO, 10_000n)]],
    [
      'another nonce',
      [authorizationUsed(PAYER, `0x${'11'.repeat(32)}`), transfer(PAYER, PAY_TO, 10_000n)],
    ],
    ['no authorization', [transfer(PAYER, PAY_TO, 10_000n)]],
    [
      'events of another contract',
      [authorizationUsed(PAYER, NONCE, OTHER), transfer(PAYER, PAY_TO, 10_000n, OTHER)],
    ],
    ['no logs', []],
  ])('records false for a receipt with %s, without an error', async (_, logs) => {
    const span = await paid(readerWith({ logs }));
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records nothing for a reverted receipt, or when no receipt comes', async () => {
    const reverted = await paid(readerWith({ logs: matching(), status: '0x0' }));
    expect(reverted.attributes['blockchain.payment.verified']).toBeUndefined();
    tracing.exporter.reset();
    const none = await paid(readerWith(null));
    expect(none.attributes['blockchain.payment.verified']).toBeUndefined();
    expect(none.attributes['blockchain.payment.status']).toBe('settled');
    expect(none.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('checks nothing without a reader, for a malformed Permit2 authorization, or with a tracker that cannot link an open span', async () => {
    expect((await paid(undefined)).attributes['blockchain.payment.verified']).toBeUndefined();
    tracing.exporter.reset();
    const permit2 = { permit2Authorization: { from: PAYER, nonce: '1' } };
    const span = await paid(readerWith({ logs: matching() }), permit2);
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
    tracing.exporter.reset();

    const real = createTxTracker();
    const olderCore = {
      ...real,
      startPayment: (...args: Parameters<typeof real.startPayment>) => {
        const { end, fail, timeout } = real.startPayment(...args);
        return { end, fail, timeout };
      },
    } as unknown as TxTracker;
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, {
      reader: readerWith({ logs: matching() }),
      tracker: olderCore,
    });
    pay();
    await hashspan.flush();
    expect(
      tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.verified'],
    ).toBeUndefined();
  });

  it('keeps the payment span ending when the response came', async () => {
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader: readerWith({ logs: matching() }) });
    const before = Date.now();
    pay();
    const after = Date.now();
    await hashspan.flush();
    const [seconds, nanos] = tracing.spanNamed(PAYMENT_SPAN).endTime;
    const endMs = seconds * 1000 + nanos / 1e6;
    expect(endMs).toBeGreaterThanOrEqual(before - 1);
    expect(endMs).toBeLessThanOrEqual(after + 1);
  });

  it('ends a payment still waiting for its receipt with its settlement when flush gives up', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader: readerWith(null), confirmTimeoutMs: 60_000 });
    pay();
    expect(tracing.spans()).toEqual([]);
    expect(await hashspan.flush({ timeoutMs: 50 })).toBe(false);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
    expect(span.attributes['error.type']).toBeUndefined();
  });
});

// The proxies' canonical addresses, mixed case as the SDK signs them; receipts carry them in lower case.
const EXACT_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
const FACILITATOR = '0x5555555555555555555555555555555555555555';
const proxyEvents = parseAbi(['event Settled()', 'event SettledWithPermit()', 'event Other()']);
const proxyLog = (
  eventName: 'Settled' | 'SettledWithPermit' | 'Other',
  address = EXACT_PROXY,
  index = 2,
) =>
  rawLog(
    address.toLowerCase(),
    encodeEventTopics({ abi: proxyEvents, eventName }) as Hex[],
    '0x',
    index,
  );

/** A Permit2 authorization of `amount` of the asset, from the payer to the recipient through `spender`. */
function permit2Signed(
  overrides: {
    from?: string;
    token?: string;
    amount?: string;
    spender?: string;
    to?: string;
    facilitator?: string;
  } = {},
) {
  const {
    from = PAYER,
    token = ASSET,
    amount = '10000',
    spender = EXACT_PROXY,
    to = PAY_TO,
  } = overrides;
  const witness: Record<string, string> = { to, validAfter: '0' };
  if ('facilitator' in overrides && overrides.facilitator !== undefined) {
    witness.facilitator = overrides.facilitator;
  }
  return {
    signature: `0x${'00'.repeat(65)}`,
    permit2Authorization: {
      from,
      permitted: { token, amount },
      spender,
      nonce: '123',
      deadline: '9999999999',
      witness,
    },
  };
}
const uptoSigned = (overrides: Parameters<typeof permit2Signed>[0] = {}) =>
  permit2Signed({ spender: UPTO_PROXY, facilitator: FACILITATOR, ...overrides });
const upto = { requirements: { scheme: 'upto' } };

/** A receipt of a transaction sent by `from` to `to` with `logs`. */
const receiptOf = (logs: unknown[], to = EXACT_PROXY, from = FACILITATOR) => ({
  logs,
  to: to.toLowerCase(),
  from: from.toLowerCase(),
});
/** The logs of a Permit2 settlement of `value` through `proxy`. */
const permit2Logs = (value = 10_000n, proxy = EXACT_PROXY) => [
  transfer(PAYER, PAY_TO, value, ASSET, 0),
  proxyLog('Settled', proxy, 1),
];

describe('checking an exact payment authorized with Permit2', () => {
  it('records true for a transaction to the proxy that settled and transferred the amount', async () => {
    const span = await paid(readerWith(receiptOf(permit2Logs())), permit2Signed());
    expect(span.attributes['blockchain.payment.verified']).toBe(true);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records true for a settlement with an EIP-2612 permit, among other logs', async () => {
    const logs = [
      rawLog(ASSET, [`0x${'99'.repeat(32)}`], '0x', 0),
      transfer(OTHER, PAY_TO, 10_000n, ASSET, 1),
      transfer(PAYER, PAY_TO, 10_000n, ASSET, 2),
      proxyLog('SettledWithPermit', EXACT_PROXY, 3),
    ];
    const span = await paid(readerWith(receiptOf(logs)), permit2Signed());
    expect(span.attributes['blockchain.payment.verified']).toBe(true);
  });

  it.each([
    ['another amount', receiptOf([transfer(PAYER, PAY_TO, 9_999n, ASSET, 0), proxyLog('Settled')])],
    [
      'another recipient',
      receiptOf([transfer(PAYER, OTHER, 10_000n, ASSET, 0), proxyLog('Settled')]),
    ],
    ['another payer', receiptOf([transfer(OTHER, PAY_TO, 10_000n, ASSET, 0), proxyLog('Settled')])],
    ['no proxy event', receiptOf([transfer(PAYER, PAY_TO, 10_000n, ASSET, 0)])],
    [
      'another event of the proxy',
      receiptOf([transfer(PAYER, PAY_TO, 10_000n, ASSET, 0), proxyLog('Other')]),
    ],
    [
      'the proxy event from another contract',
      receiptOf([transfer(PAYER, PAY_TO, 10_000n, ASSET, 0), proxyLog('Settled', OTHER)]),
    ],
    [
      'the transfer from another contract',
      receiptOf([transfer(PAYER, PAY_TO, 10_000n, OTHER, 0), proxyLog('Settled')]),
    ],
    ['a transaction to another contract', receiptOf(permit2Logs(), OTHER)],
    ['no logs', receiptOf([])],
  ])('records false for a receipt with %s', async (_, receipt) => {
    const span = await paid(readerWith(receipt), permit2Signed());
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records nothing for a reverted receipt', async () => {
    const span = await paid(
      readerWith({ ...receiptOf(permit2Logs()), status: '0x0' }),
      permit2Signed(),
    );
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it.each([
    ['another token', permit2Signed({ token: OTHER })],
    ['another recipient', permit2Signed({ to: OTHER })],
    ['another amount', permit2Signed({ amount: '10001' })],
    ['a malformed amount', permit2Signed({ amount: '0x10' })],
    ['a malformed payer', permit2Signed({ from: 'payer' })],
    ['a malformed spender', permit2Signed({ spender: '0x1234' })],
  ])('checks nothing for an authorization of %s than the requirements', async (_, signed) => {
    const span = await paid(readerWith(receiptOf(permit2Logs())), signed);
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it('checks nothing for a scheme without a check', async () => {
    // A receipt that would carry the payment as an exact or upto one.
    const receipt = receiptOf(permit2Logs(10_000n, UPTO_PROXY), UPTO_PROXY);
    const span = await paid(readerWith(receipt), uptoSigned(), {
      requirements: { scheme: 'batch-settlement' },
    });
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });
});

describe('checking an upto payment', () => {
  const uptoReceipt = (value: bigint, from = FACILITATOR) =>
    receiptOf(permit2Logs(value, UPTO_PROXY), UPTO_PROXY, from);
  const reporting = (amount: string | undefined) => ({
    ...upto,
    settlement: amount === undefined ? {} : { amount },
  });

  it('records true for a transfer of the reported amount, at most the maximum', async () => {
    const less = await paid(readerWith(uptoReceipt(4_000n)), uptoSigned(), reporting('4000'));
    expect(less.attributes['blockchain.payment.verified']).toBe(true);
    expect(less.attributes['blockchain.payment.settled_amount']).toBe('4000');
    tracing.exporter.reset();
    const all = await paid(readerWith(uptoReceipt(10_000n)), uptoSigned(), reporting('10000'));
    expect(all.attributes['blockchain.payment.verified']).toBe(true);
    tracing.exporter.reset();
    const unreported = await paid(readerWith(uptoReceipt(1n)), uptoSigned(), reporting(undefined));
    expect(unreported.attributes['blockchain.payment.verified']).toBe(true);
  });

  it.each([
    ['more than the maximum', uptoReceipt(10_001n), undefined],
    ['nothing transferred', uptoReceipt(0n), undefined],
    ['another amount than reported', uptoReceipt(4_000n), '5000'],
    ['a reported amount that is not one', uptoReceipt(4_000n), 'four thousand'],
    ['another sender than the facilitator', uptoReceipt(4_000n, OTHER), undefined],
    ['a transaction to the exact proxy', receiptOf(permit2Logs(4_000n, UPTO_PROXY)), undefined],
  ])('records false for a receipt with %s', async (_, receipt, amount) => {
    const span = await paid(readerWith(receipt), uptoSigned(), reporting(amount));
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
  });

  it.each([
    ['no facilitator', permit2Signed({ spender: UPTO_PROXY })],
    ['a malformed facilitator', uptoSigned({ facilitator: 'facilitator' })],
    ['another maximum than the requirements', uptoSigned({ amount: '20000' })],
  ])('checks nothing for an authorization with %s', async (_, signed) => {
    const span = await paid(readerWith(uptoReceipt(4_000n)), signed, upto);
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });
});

describe('a settlement transaction reported again', () => {
  /** One traced client paying `times` times, each payment reporting the settlement transaction `hash(i)`. */
  async function payments(
    receipt: Record<string, unknown>,
    signed: () => unknown,
    hashes: string[],
    options: { requirements?: { scheme: string } } = {},
  ) {
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader: readerWith(receipt), confirmTimeoutMs: 200 });
    const verdicts: unknown[] = [];
    for (const transaction of hashes) {
      tracing.exporter.reset();
      pay(signed(), { ...options, settlement: { transaction } });
      await hashspan.flush();
      verdicts.push(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.verified']);
    }
    return verdicts;
  }

  it('is false for a later Permit2 payment of the same client', async () => {
    const verdicts = await payments(receiptOf(permit2Logs()), permit2Signed, [
      RECEIPT_HASH,
      RECEIPT_HASH.toUpperCase().replace('0X', '0x'),
    ]);
    expect(verdicts).toEqual([true, false]);
    const upTo = await payments(
      receiptOf(permit2Logs(4_000n, UPTO_PROXY), UPTO_PROXY),
      uptoSigned,
      [RECEIPT_HASH, RECEIPT_HASH],
      upto,
    );
    expect(upTo).toEqual([true, false]);
  });

  it('is checked again by another client, and after a check that failed', async () => {
    expect(await payments(receiptOf(permit2Logs()), permit2Signed, [RECEIPT_HASH])).toEqual([true]);
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader: readerWith(receiptOf(permit2Logs())) });
    // An authorization of 9999: the transfer of 10000 is not this payment.
    pay(permit2Signed({ amount: '9999' }), { requirements: { amount: '9999' } });
    await hashspan.flush();
    pay(permit2Signed());
    await hashspan.flush();
    expect(
      tracing
        .spans()
        .filter((span) => span.name === PAYMENT_SPAN)
        .map((span) => span.attributes['blockchain.payment.verified']),
    ).toEqual([true, false, true]);
  });

  it('is remembered for the last 1000 verified transactions', async () => {
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, {
      reader: readerWith(receiptOf(permit2Logs())),
      confirmTimeoutMs: 1000,
    });
    const hashOf = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;
    for (let start = 0; start <= 1000; start += 200) {
      for (let i = start; i < Math.min(start + 200, 1001); i++) {
        pay(permit2Signed(), { settlement: { transaction: hashOf(i) } });
      }
      await hashspan.flush();
    }
    const verified = tracing
      .spans()
      .filter((span) => span.name === PAYMENT_SPAN)
      .map((span) => span.attributes['blockchain.payment.verified']);
    expect(verified).toHaveLength(1001);
    expect(verified.every((value) => value === true)).toBe(true);
    tracing.exporter.reset();
    // The second transaction is still remembered; the first was forgotten when the 1001st was verified.
    pay(permit2Signed(), { settlement: { transaction: hashOf(1) } });
    await hashspan.flush();
    pay(permit2Signed(), { settlement: { transaction: hashOf(0) } });
    await hashspan.flush();
    expect(tracing.spans().map((span) => span.attributes['blockchain.payment.verified'])).toEqual([
      false,
      true,
    ]);
  });

  it('does not apply to EIP-3009 payments, whose logs carry their nonce', async () => {
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader: readerWith({ logs: matching() }) });
    pay();
    await hashspan.flush();
    pay();
    await hashspan.flush();
    expect(
      tracing
        .spans()
        .filter((span) => span.name === PAYMENT_SPAN)
        .map((span) => span.attributes['blockchain.payment.verified']),
    ).toEqual([true, true]);
  });
});
