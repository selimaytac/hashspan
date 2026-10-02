import { createTxTracker, type TxTracker } from '@hashspan/core';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { x402ExactPermit2ProxyABI, x402UptoPermit2ProxyABI } from '@x402/evm';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
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

/** A reader on Base Sepolia returning `receipt` and, for the transaction, `input`; `calls` lists its requests. */
const recordingReader = (
  receipt: Record<string, unknown> | null,
  input?: Hex,
  options: Parameters<typeof mockTransport>[0] = {},
) => {
  const { transport, calls } = mockTransport({
    chainIdHex: '0x14a34',
    receipt,
    ...(input === undefined ? {} : { transaction: { input } }),
    ...options,
  });
  return {
    reader: createPublicClient({ chain: baseSepolia, transport, pollingInterval: 10 }),
    calls,
  };
};
const readerWith = (receipt: Record<string, unknown> | null, input?: Hex) =>
  recordingReader(receipt, input).reader;

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
    nonce?: string;
  } = {},
) {
  const {
    from = PAYER,
    token = ASSET,
    amount = '10000',
    spender = EXACT_PROXY,
    to = PAY_TO,
    nonce = PERMIT2_NONCE.toString(),
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
      nonce,
      deadline: '9999999999',
      witness,
    },
  };
}
const uptoSigned = (overrides: Parameters<typeof permit2Signed>[0] = {}) =>
  permit2Signed({ spender: UPTO_PROXY, facilitator: FACILITATOR, ...overrides });
const upto = { requirements: { scheme: 'upto' } };

/** The Permit2 nonce of the default authorization: a decimal string in the payload, as the SDK signs it. */
const PERMIT2_NONCE = 123n;
const SIGNATURE = `0x${'00'.repeat(65)}` as const;
const PERMIT2612 = {
  value: 10_000n,
  deadline: 9_999_999_999n,
  r: `0x${'00'.repeat(32)}`,
  s: `0x${'00'.repeat(32)}`,
  v: 27,
} as const;
/**
 * The input of a settlement through a proxy, encoded with the SDK's ABIs: `settle` or `settleWithPermit` of the
 * exact proxy, or of the upto proxy with `amount`.
 */
function settlementInput(
  options: {
    scheme?: 'exact' | 'upto';
    functionName?: 'settle' | 'settleWithPermit';
    nonce?: bigint;
    owner?: string;
    amount?: bigint;
  } = {},
): Hex {
  const {
    scheme = 'exact',
    functionName = 'settle',
    nonce = PERMIT2_NONCE,
    owner = PAYER,
    amount = 10_000n,
  } = options;
  const permit = {
    permitted: { token: ASSET as Hex, amount: 10_000n },
    nonce,
    deadline: 9_999_999_999n,
  };
  const withPermit = functionName === 'settleWithPermit' ? [PERMIT2612] : [];
  if (scheme === 'exact') {
    const witness = { to: PAY_TO as Hex, validAfter: 0n };
    return encodeFunctionData({
      abi: x402ExactPermit2ProxyABI,
      functionName,
      args: [...withPermit, permit, owner as Hex, witness, SIGNATURE],
    } as never);
  }
  const witness = { to: PAY_TO as Hex, facilitator: FACILITATOR as Hex, validAfter: 0n };
  return encodeFunctionData({
    abi: x402UptoPermit2ProxyABI,
    functionName,
    args: [...withPermit, permit, amount, owner as Hex, witness, SIGNATURE],
  } as never);
}
/** A reader for an exact Permit2 settlement: `receipt`, and the transaction input of the default payment. */
const permit2Reader = (receipt: Record<string, unknown> | null, input = settlementInput()) =>
  readerWith(receipt, input);

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
    const span = await paid(permit2Reader(receiptOf(permit2Logs())), permit2Signed());
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
    const span = await paid(permit2Reader(receiptOf(logs)), permit2Signed());
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
    const span = await paid(permit2Reader(receipt), permit2Signed());
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records nothing for a reverted receipt', async () => {
    const span = await paid(
      permit2Reader({ ...receiptOf(permit2Logs()), status: '0x0' }),
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
    const span = await paid(permit2Reader(receiptOf(permit2Logs())), signed);
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it('checks nothing for a scheme without a check', async () => {
    // A receipt that would carry the payment as an exact or upto one.
    const receipt = receiptOf(permit2Logs(10_000n, UPTO_PROXY), UPTO_PROXY);
    const span = await paid(permit2Reader(receipt), uptoSigned(), {
      requirements: { scheme: 'batch-settlement' },
    });
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });
});

describe('checking an upto payment', () => {
  const uptoReceipt = (value: bigint, from = FACILITATOR) =>
    receiptOf(permit2Logs(value, UPTO_PROXY), UPTO_PROXY, from);
  const uptoReader = (receipt: Record<string, unknown>) =>
    readerWith(receipt, settlementInput({ scheme: 'upto' }));
  const reporting = (amount: string | undefined) => ({
    ...upto,
    settlement: amount === undefined ? {} : { amount },
  });

  it('records true for a transfer of the reported amount, at most the maximum', async () => {
    const less = await paid(uptoReader(uptoReceipt(4_000n)), uptoSigned(), reporting('4000'));
    expect(less.attributes['blockchain.payment.verified']).toBe(true);
    expect(less.attributes['blockchain.payment.settled_amount']).toBe('4000');
    tracing.exporter.reset();
    const all = await paid(uptoReader(uptoReceipt(10_000n)), uptoSigned(), reporting('10000'));
    expect(all.attributes['blockchain.payment.verified']).toBe(true);
    tracing.exporter.reset();
    const unreported = await paid(uptoReader(uptoReceipt(1n)), uptoSigned(), reporting(undefined));
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
    const span = await paid(uptoReader(receipt), uptoSigned(), reporting(amount));
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
  });

  it.each([
    ['no facilitator', permit2Signed({ spender: UPTO_PROXY })],
    ['a malformed facilitator', uptoSigned({ facilitator: 'facilitator' })],
    ['another maximum than the requirements', uptoSigned({ amount: '20000' })],
  ])('checks nothing for an authorization with %s', async (_, signed) => {
    const span = await paid(uptoReader(uptoReceipt(4_000n)), signed, upto);
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });
});

describe('checking the nonce in a Permit2 settlement transaction', () => {
  const uptoReceipt = () => receiptOf(permit2Logs(4_000n, UPTO_PROXY), UPTO_PROXY);

  it.each([
    ['exact', 'settle'],
    ['exact', 'settleWithPermit'],
    ['upto', 'settle'],
    ['upto', 'settleWithPermit'],
  ] as const)(
    'records true for %s %s with the payer and nonce of the payment',
    async (scheme, functionName) => {
      const input = settlementInput({ scheme, functionName, amount: 4_000n });
      const span =
        scheme === 'exact'
          ? await paid(readerWith(receiptOf(permit2Logs()), input), permit2Signed())
          : await paid(readerWith(uptoReceipt(), input), uptoSigned(), upto);
      expect(span.attributes['blockchain.payment.verified']).toBe(true);
    },
  );

  it.each([
    ['another nonce', settlementInput({ nonce: PERMIT2_NONCE + 1n })],
    ['another owner', settlementInput({ owner: OTHER })],
    [
      'another nonce, with an EIP-2612 permit',
      settlementInput({ functionName: 'settleWithPermit', nonce: 1n }),
    ],
    ['the input of the upto proxy', settlementInput({ scheme: 'upto' })],
    ['an ERC-20 transfer', '0xa9059cbb' as Hex],
    ['no input', '0x' as Hex],
  ])('records false for a transaction with %s, without an error', async (_, input) => {
    const span = await paid(readerWith(receiptOf(permit2Logs()), input), permit2Signed());
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records false for an upto payment settled with the input of the exact proxy', async () => {
    const span = await paid(readerWith(uptoReceipt(), settlementInput()), uptoSigned(), upto);
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
  });

  it('records nothing when the transaction cannot be read', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { reader } = recordingReader(receiptOf(permit2Logs()), settlementInput(), {
      failOn: ['eth_getTransactionByHash'],
    });
    const span = await paid(reader, permit2Signed());
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
  });

  it('ends the payment without a verdict when flush gives up while the transaction is read', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { reader, calls } = recordingReader(receiptOf(permit2Logs()), settlementInput(), {
      hangOn: ['eth_getTransactionByHash'],
    });
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 60_000 });
    pay(permit2Signed());
    await vi.waitFor(() => expect(calls).toContain('eth_getTransactionByHash'));
    expect(await hashspan.flush({ timeoutMs: 50 })).toBe(false);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it('reads the transaction only when the receipt carries a Permit2 payment', async () => {
    const decided = recordingReader(receiptOf(permit2Logs(9_999n)), settlementInput());
    expect(
      (await paid(decided.reader, permit2Signed())).attributes['blockchain.payment.verified'],
    ).toBe(false);
    tracing.exporter.reset();
    const eip3009 = recordingReader({ logs: matching() });
    expect((await paid(eip3009.reader)).attributes['blockchain.payment.verified']).toBe(true);
    expect([...decided.calls, ...eip3009.calls]).not.toContain('eth_getTransactionByHash');
  });
});

describe('a settlement transaction reported again', () => {
  it('is false for a later Permit2 payment, in the same client or another one', async () => {
    // The transaction settles the payment with the default nonce; the later payment signed another one.
    const reader = permit2Reader(receiptOf(permit2Logs()));
    const later = () => permit2Signed({ nonce: (PERMIT2_NONCE + 1n).toString() });
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader });
    pay(permit2Signed());
    await hashspan.flush();
    pay(later());
    await hashspan.flush();
    // Another client, as after a restart, knows nothing of the first payment.
    const other = capturingClient();
    const otherHashspan = withHashspan(other.client, { reader });
    other.pay(later());
    await otherHashspan.flush();
    expect(
      tracing
        .spans()
        .filter((span) => span.name === PAYMENT_SPAN)
        .map((span) => span.attributes['blockchain.payment.verified']),
    ).toEqual([true, false, false]);
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
