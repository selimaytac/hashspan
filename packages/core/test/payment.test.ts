import { context, diag, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker, type PaymentInput } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = '0x9f2c1e3a5b7d9f2c1e3a5b7d9f2c1e3a5b7d9f2c1e3a5b7d9f2c1e3a5b7d9f2c';
const PAYER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYMENT_SPAN = `payment ${CHAIN_ID}`;

const payment: PaymentInput = {
  chainId: CHAIN_ID,
  protocol: 'x402',
  payer: PAYER,
  recipient: RECIPIENT,
  asset: ASSET,
  amount: 10_000n,
  x402: { scheme: 'exact', resource: 'https://api.example.com/weather' },
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('payment span', () => {
  it('is a CLIENT child of the active span with the payment and its settlement', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool weather');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker.startPayment(payment).end({ status: 'settled', hash: HASH });
    });
    tool.end();

    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(span.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'payment',
      'blockchain.payment.protocol': 'x402',
      'blockchain.payment.payer': PAYER,
      'blockchain.payment.recipient': RECIPIENT,
      'blockchain.payment.asset': ASSET.toLowerCase(),
      'blockchain.payment.amount': '10000',
      'blockchain.payment.status': 'settled',
      'blockchain.tx.hash': HASH,
      'x402.scheme': 'exact',
      'x402.resource': 'https://api.example.com',
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records a pending settlement without an error', () => {
    createTxTracker().startPayment(payment).end({ status: 'pending', hash: HASH });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('pending');
    expect(span.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records a failed settlement with the settling party's reason as error.type", () => {
    createTxTracker()
      .startPayment(payment)
      .end({ status: 'failed', errorReason: 'insufficient_funds' });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('failed');
    expect(span.attributes['error.type']).toBe('insufficient_funds');
    expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events).toEqual([]);
  });

  it('records _OTHER for a failure reason that is not a short identifier', () => {
    const tracker = createTxTracker();
    for (const errorReason of [undefined, 'has spaces', 'x'.repeat(65), 42 as unknown as string]) {
      tracker.startPayment(payment).end({ status: 'failed', errorReason });
    }
    expect(tracing.spans().map((s) => s.attributes['error.type'])).toEqual([
      '_OTHER',
      '_OTHER',
      '_OTHER',
      '_OTHER',
    ]);
  });

  it('keeps the payer and amount the payer knew over those the settlement reports', () => {
    // The settling party reports these values; the payer's own are the ones it signed.
    createTxTracker().startPayment(payment).end({
      status: 'settled',
      hash: HASH,
      payer: '0x3333333333333333333333333333333333333333',
      amount: '9000',
    });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.payer']).toBe(PAYER);
    expect(span.attributes['blockchain.payment.amount']).toBe('10000');
    // What was settled is still recorded, on its own, as the settling party reported it.
    expect(span.attributes['blockchain.payment.settled_amount']).toBe('9000');
  });

  it('records whether the settlement transaction carries the payment, as the adapter checked it', () => {
    const tracker = createTxTracker();
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH, verified: true });
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH, verified: false });
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH });
    tracker
      .startPayment(payment)
      .end({ status: 'settled', hash: HASH, verified: 'yes' as unknown as boolean });
    const spans = tracing.spans();
    expect(spans.map((s) => s.attributes['blockchain.payment.verified'])).toEqual([
      true,
      false,
      undefined,
      undefined,
    ]);
    // A verdict is not an error.
    expect(spans.map((s) => s.status.code)).toEqual(Array(4).fill(SpanStatusCode.UNSET));
  });

  it('records no settled amount when the settlement reports none or a malformed one', () => {
    const tracker = createTxTracker();
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH });
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH, amount: '-5' });
    expect(tracing.spans().map((s) => s.attributes['blockchain.payment.settled_amount'])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('records the payer and amount of the settlement only where the input had none', () => {
    const settledPayer = '0x3333333333333333333333333333333333333333';
    createTxTracker()
      .startPayment({ ...payment, payer: undefined, amount: undefined })
      .end({ status: 'settled', hash: HASH, payer: settledPayer, amount: '9000' });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.payer']).toBe(settledPayer);
    expect(span.attributes['blockchain.payment.amount']).toBe('9000');
  });

  it('does not take over the link of a transaction the tracker already sent', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    const sent = context.with(trace.setSpan(context.active(), tool), () => {
      const send = tracker.startSend({ chainId: CHAIN_ID });
      send.end({ hash: HASH });
      return send;
    });
    tool.end();
    // A settlement that names the hash of a transaction this tracker sent itself.
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end({
      status: 'success',
      blockNumber: 1n,
      gasUsed: 21_000n,
    });
    expect(sent).toBeDefined();
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.links.map((l) => l.context.spanId)).toEqual([
      tracing.spanNamed(`send ${CHAIN_ID}`).spanContext().spanId,
    ]);
  });

  it('records a failure to create the payment as an error with no settlement', () => {
    class SpendLimitError extends Error {
      override name = 'SpendLimitError';
    }
    createTxTracker()
      .startPayment(payment)
      .fail(new SpendLimitError('over the limit'), { errorType: 'spend_limit' });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('spend_limit');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.events[0]?.attributes?.['exception.type']).toBe('SpendLimitError');
  });

  it('ends as timeout without a status when the outcome was never learned', () => {
    const end = new Date(Date.now() + 1_000);
    createTxTracker()
      .startPayment({ ...payment, startTime: new Date() })
      .timeout({ endTime: end });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.events).toEqual([]);
    expect(span.endTime[0]).toBe(Math.floor(end.getTime() / 1000));
  });

  it('records an outcome that is not an exception without an exception event', () => {
    createTxTracker().startPayment(payment).fail(undefined, { errorType: 'no_settlement' });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('no_settlement');
    expect(span.events).toEqual([]);
  });

  it('ignores repeated end/fail calls', () => {
    const handle = createTxTracker().startPayment(payment);
    handle.end({ status: 'settled', hash: HASH });
    handle.fail(new Error('late'));
    handle.end({ status: 'failed' });
    handle.timeout();
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('starts at an explicit start time and under an explicit parent', () => {
    const tracker = createTxTracker();
    const parent = trace.getTracer('test').startSpan('parent');
    const start = new Date(Date.now() - 5_000);
    tracker
      .startPayment({ ...payment, startTime: start }, trace.setSpan(context.active(), parent))
      .end({ status: 'settled' }, { endTime: new Date() });
    parent.end();
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span.startTime[0]).toBe(Math.floor(start.getTime() / 1000));
  });
});

describe('payment confirmation', () => {
  it('links the confirm span to a payment span that is still open, once linked by hash', () => {
    const tracker = createTxTracker();
    const handle = tracker.startPayment(payment);
    handle.link(HASH);
    // The confirm span starts before the payment span ends, as when an adapter checks the receipt first.
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ status: 'success', blockNumber: 1n, gasUsed: 1n });
    handle.end({ status: 'settled', hash: HASH, verified: true }, { endTime: new Date() });
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).links.map((l) => l.context.spanId)).toEqual([
      tracing.spanNamed(PAYMENT_SPAN).spanContext().spanId,
    ]);
  });

  it('does not take over a link, and ignores a hash that is not one', () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
    const handle = tracker.startPayment(payment);
    handle.link(HASH);
    handle.link('not a hash');
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ status: 'success', blockNumber: 1n, gasUsed: 1n });
    handle.end({ status: 'settled' });
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).links.map((l) => l.context.spanId)).toEqual([
      tracing.spanNamed(`send ${CHAIN_ID}`).spanContext().spanId,
    ]);
  });

  it('links the confirm span of the settling transaction and confirms in the background', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool weather');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker.startPayment(payment).end({ status: 'pending', hash: HASH });
    });
    tool.end();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ status: 'success', blockNumber: 1n, gasUsed: 50_000n });

    const paid = tracing.spanNamed(PAYMENT_SPAN);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.links.map((l) => l.context.spanId)).toEqual([paid.spanContext().spanId]);
    expect(confirm.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  });

  it('does not link a settlement without a valid hash', () => {
    const tracker = createTxTracker();
    tracker.startPayment(payment).end({ status: 'settled', hash: HASH.slice(0, 40) });
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH.slice(0, 40) })
      .end({ status: 'success', blockNumber: 1n, gasUsed: 1n });
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.tx.hash']).toBeUndefined();
    // Nor is a confirmation of it recorded: the hash keys the confirm span.
    expect(tracing.spans().map((span) => span.name)).toEqual([PAYMENT_SPAN]);
  });
});

describe('payment privacy', () => {
  const resources = [
    'https://api.example.com/v1/users/alice/report?apiKey=secret',
    'https://user:secret@api.example.com:8443/weather#token=secret',
    'mcp://tool/get_weather',
    'get_weather?key=secret',
  ];
  const recorded = (paymentResource?: 'origin' | 'path' | 'off') => {
    const tracker = createTxTracker({ paymentResource });
    for (const resource of resources) {
      tracker.startPayment({ ...payment, x402: { resource } }).end({ status: 'settled' });
    }
    return tracing.spans().map((s) => s.attributes['x402.resource']);
  };

  it('records only the origin of the resource by default, and nothing for a resource that is not a URL', () => {
    expect(recorded()).toEqual([
      'https://api.example.com',
      'https://api.example.com:8443',
      'mcp://tool',
      undefined,
    ]);
  });

  it('records no resource with paymentResource off, or an unknown mode', () => {
    expect(recorded('off')).toEqual([undefined, undefined, undefined, undefined]);
    tracing.exporter.reset();
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    expect(recorded('everything' as 'path')).toEqual([undefined, undefined, undefined, undefined]);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: unknown payment resource mode "everything"; not recording payment resources',
    );
  });

  it('records the path, without query string, fragment or user info, with paymentResource path', () => {
    expect(recorded('path')).toEqual([
      'https://api.example.com/v1/users/alice/report',
      'https://api.example.com:8443/weather',
      'mcp://tool/get_weather',
      'get_weather',
    ]);
  });

  it('records the resource without query string, fragment or user info', () => {
    const tracker = createTxTracker({ paymentResource: 'path' });
    const resources = [
      'https://api.example.com/weather?apiKey=secret',
      'https://api.example.com/weather#token=secret',
      'https://user:secret@api.example.com/weather',
      'https://api.example.com/weather/?q=a#b',
      'mcp://tool/get_weather',
      'get_weather?key=secret',
    ];
    for (const resource of resources) {
      tracker.startPayment({ ...payment, x402: { resource } }).end({ status: 'settled' });
    }
    expect(tracing.spans().map((s) => s.attributes['x402.resource'])).toEqual([
      'https://api.example.com/weather',
      'https://api.example.com/weather',
      'https://api.example.com/weather',
      'https://api.example.com/weather/',
      'mcp://tool/get_weather',
      'get_weather',
    ]);
  });

  it('records no resource whose user info hides a query or fragment character, in either mode', () => {
    // Not a valid URL: in one, `?` and `#` inside the user info are percent-encoded.
    const resources = [
      'https://user:p?ss@api.example.com/weather',
      'https://user:p#ss@api.example.com/weather',
    ];
    for (const paymentResource of ['origin', 'path'] as const) {
      const tracker = createTxTracker({ paymentResource });
      for (const resource of resources) {
        tracker.startPayment({ ...payment, x402: { resource } }).end({ status: 'settled' });
      }
    }
    expect(tracing.spans().map((s) => s.attributes['x402.resource'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('bounds the length of the resource it records', () => {
    const resource = `https://api.example.com/${'a'.repeat(5_000)}`;
    createTxTracker({ paymentResource: 'path' })
      .startPayment({ ...payment, x402: { resource } })
      .end({ status: 'settled' });
    const recorded = tracing.spans()[0]?.attributes['x402.resource'];
    expect(typeof recorded).toBe('string');
    expect((recorded as string).length).toBeLessThanOrEqual(512 + 3);
    expect(recorded as string).toMatch(/^https:\/\/api\.example\.com\/a+\.\.\.$/);
  });

  it('drops a hex value cut by the length bound whole, so no part of an address is recorded', () => {
    const path = `https://api.example.com/${'a'.repeat(470)}/`;
    createTxTracker({ address: 'off', paymentResource: 'path' })
      .startPayment({ ...payment, x402: { resource: `${path}${PAYER}` } })
      .end({ status: 'settled' });
    expect(tracing.spans()[0]?.attributes['x402.resource']).toBe(`${path}...`);
  });

  it('records addresses in the resource per the address mode', () => {
    const resource = `https://api.example.com/balance/${PAYER}`;
    createTxTracker({ address: 'off', paymentResource: 'path' })
      .startPayment({ ...payment, x402: { resource } })
      .end({ status: 'settled' });
    createTxTracker({ address: { mode: 'hashed', hash: () => 'h' }, paymentResource: 'path' })
      .startPayment({ ...payment, x402: { resource } })
      .end({ status: 'settled' });
    expect(tracing.spans().map((s) => s.attributes['x402.resource'])).toEqual([
      'https://api.example.com/balance/<address>',
      'https://api.example.com/balance/h',
    ]);
  });

  it('records addresses per the address mode', () => {
    createTxTracker({ address: 'off' })
      .startPayment(payment)
      .end({ status: 'settled', payer: PAYER });
    const attributes = tracing.spanNamed(PAYMENT_SPAN).attributes;
    expect(attributes['blockchain.payment.payer']).toBeUndefined();
    expect(attributes['blockchain.payment.recipient']).toBeUndefined();
    expect(attributes['blockchain.payment.asset']).toBeUndefined();
    expect(attributes['blockchain.payment.amount']).toBe('10000');
  });

  it('does not record malformed values from the settling party', () => {
    createTxTracker()
      .startPayment({
        chainId: CHAIN_ID,
        protocol: 'x 402',
        payer: 'alice',
        recipient: `${RECIPIENT}00`,
        asset: 42 as unknown as string,
        amount: '-1',
        x402: { scheme: 'exact scheme', resource: '' },
      })
      .end({
        status: 'settled',
        payer: 'not an address',
        amount: '1e6',
        hash: 'not a hash',
      });
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'payment',
      'blockchain.payment.status': 'settled',
    });
  });

  it('records no status for an unknown settlement status', () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    createTxTracker()
      .startPayment(payment)
      .end({ status: 'done' as 'settled', hash: HASH });
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
  });

  it('keeps the payment protocol and status when the redaction hook fails', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    createTxTracker({
      redact: () => {
        throw new Error('broken hook');
      },
    })
      .startPayment(payment)
      .end({ status: 'settled', hash: HASH, verified: false });
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'payment',
      'blockchain.payment.protocol': 'x402',
      'blockchain.payment.status': 'settled',
      'blockchain.payment.verified': false,
      'blockchain.tx.hash': HASH,
    });
  });
});

describe('payment never breaks the caller', () => {
  it('returns a no-op handle when starting the span fails', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker();
    const handle = tracker.startPayment(null as unknown as PaymentInput);
    expect(() => handle.end({ status: 'settled' })).not.toThrow();
    expect(() => handle.fail(new Error('x'))).not.toThrow();
    expect(() => handle.timeout()).not.toThrow();
    expect(tracing.spans()).toEqual([]);
  });

  it('ends the span when recording the settlement fails', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const handle = createTxTracker().startPayment(payment);
    expect(() => handle.end(null as unknown as { status: 'settled' })).not.toThrow();
    expect(tracing.spans()).toHaveLength(1);
  });
});
