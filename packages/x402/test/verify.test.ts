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
  const pay = (signed: unknown = { authorization: { from: PAYER, nonce: NONCE } }) => {
    const required = paymentRequired();
    const selectedRequirements = required.accepts[0];
    const paymentPayload = { x402Version: 2, payload: signed };
    hooks.before?.({ paymentRequired: required, selectedRequirements });
    hooks.after?.({ paymentRequired: required, selectedRequirements, paymentPayload });
    hooks.response?.({
      paymentPayload,
      requirements: selectedRequirements,
      settleResponse: { success: true, transaction: RECEIPT_HASH, network: 'eip155:84532' },
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
async function paid(reader: ReturnType<typeof readerWith> | undefined, signed?: unknown) {
  const { client, pay } = capturingClient();
  const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 200 });
  pay(signed);
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

  it('checks nothing without a reader, for Permit2, or with a tracker that cannot link an open span', async () => {
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
