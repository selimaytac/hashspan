import { context, diag, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { wrapFetchWithPayment } from '@x402/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  ASSET,
  HASH,
  PAY_TO,
  PAYER,
  paidApi,
  paymentRequired,
  settledWith,
  testClient,
} from './fake-x402.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PAYMENT_SPAN = 'payment 84532';
const URL_PAID = 'https://api.example.com/weather?key=secret';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** Resolves with `value` once `release` is called. */
function deferred<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release = (_: T): void => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('a paid request', () => {
  it('is a payment span under the caller, with what was paid and the settlement', async () => {
    const client = testClient();
    withHashspan(client);
    const pay = wrapFetchWithPayment(
      paidApi(() => settledWith({ amount: '9000' })),
      client,
    );

    const tool = trace.getTracer('test').startSpan('execute_tool weather');
    const response = await context.with(trace.setSpan(context.active(), tool), () => pay(URL_PAID));
    tool.end();

    expect(response.status).toBe(200);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(span.attributes).toMatchObject({
      'blockchain.operation.name': 'payment',
      'blockchain.chain.id': 84532,
      'blockchain.payment.protocol': 'x402',
      'blockchain.payment.payer': PAYER,
      'blockchain.payment.recipient': PAY_TO,
      'blockchain.payment.asset': ASSET,
      // The amount the payer signed for, not the one the settlement reports.
      'blockchain.payment.amount': '10000',
      'blockchain.payment.settled_amount': '9000',
      'blockchain.payment.status': 'settled',
      'blockchain.tx.hash': HASH,
      'x402.scheme': 'exact',
      'x402.resource': 'https://api.example.com',
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records a pending settlement', async () => {
    const client = testClient();
    withHashspan(client);
    const pay = wrapFetchWithPayment(
      paidApi(() => settledWith({ success: false, errorReason: 'settlement_pending' })),
      client,
    );
    await pay(URL_PAID);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('pending');
    expect(span.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records a failed settlement with the facilitator's reason", async () => {
    const client = testClient();
    withHashspan(client);
    const pay = wrapFetchWithPayment(
      paidApi(() =>
        settledWith({ success: false, errorReason: 'insufficient_funds', transaction: '' }, 402),
      ),
      client,
    );
    await pay(URL_PAID);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('failed');
    expect(span.attributes['error.type']).toBe('insufficient_funds');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('ends as no_settlement when the response carries none', async () => {
    const client = testClient();
    withHashspan(client);
    const pay = wrapFetchWithPayment(
      paidApi(() => new Response('oops', { status: 500 })),
      client,
    );
    expect((await pay(URL_PAID)).status).toBe(500);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('no_settlement');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events).toEqual([]);
  });

  it('gives each of two concurrent payments its own settlement', async () => {
    const client = testClient();
    withHashspan(client, { paymentResource: 'path' });
    const first = deferred<Response>();
    const second = deferred<Response>();
    const hashOf = (n: number) => `0x${String(n).repeat(64)}`;
    let arrived = 0;
    const pay = wrapFetchWithPayment(
      paidApi(
        (request) => {
          arrived += 1;
          return request.url.endsWith('/1') ? first.promise : second.promise;
        },
        (request) => ({ ...paymentRequired(), resource: { url: request.url } }),
      ),
      client,
    );

    const calls = [pay('https://api.example.com/1'), pay('https://api.example.com/2')];
    await vi.waitFor(() => expect(arrived).toBe(2));
    // Answered in reverse order.
    second.release(settledWith({ transaction: hashOf(2) }));
    first.release(settledWith({ transaction: hashOf(1) }));
    await Promise.all(calls);

    const byResource = Object.fromEntries(
      tracing
        .spans()
        .map((s) => [s.attributes['x402.resource'], s.attributes['blockchain.tx.hash']]),
    );
    expect(byResource).toEqual({
      'https://api.example.com/1': hashOf(1),
      'https://api.example.com/2': hashOf(2),
    });
  });
});

describe('the SDK behaviour the adapter relies on', () => {
  // The SDK does not document these identities; the weekly job against the newest SDK runs this test.
  it('passes one requirements object from before to after, and one payload from after to the response', async () => {
    const client = testClient();
    const seen: Record<string, unknown> = {};
    client.onBeforePaymentCreation(async (ctx) => {
      seen.beforeRequirements = ctx.selectedRequirements;
    });
    client.onAfterPaymentCreation(async (ctx) => {
      seen.afterRequirements = ctx.selectedRequirements;
      seen.afterPayload = ctx.paymentPayload;
    });
    client.onPaymentResponse(async (ctx) => {
      seen.responsePayload = ctx.paymentPayload;
    });
    await wrapFetchWithPayment(
      paidApi(() => settledWith({})),
      client,
    )(URL_PAID);
    expect(seen.afterRequirements).toBe(seen.beforeRequirements);
    expect(seen.responsePayload).toBe(seen.afterPayload);
  });
});

describe('payments that are not completed', () => {
  it('records a failure to create the payment', async () => {
    class SigningError extends Error {
      override name = 'SigningError';
    }
    const client = testClient(async () => {
      throw new SigningError('no key');
    });
    withHashspan(client);
    await expect(
      wrapFetchWithPayment(
        paidApi(() => settledWith({})),
        client,
      )(URL_PAID),
    ).rejects.toThrow();
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('SigningError');
    expect(span.attributes['blockchain.payment.payer']).toBeUndefined();
  });

  it('records a failure reported after its own after-hook ran, without leaving the span open', async () => {
    const client = testClient();
    const hashspan = withHashspan(client);
    client.onAfterPaymentCreation(async () => {
      throw new TypeError('a later hook failed');
    });
    await expect(
      wrapFetchWithPayment(
        paidApi(() => settledWith({})),
        client,
      )(URL_PAID),
    ).rejects.toThrow();
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('TypeError');
    expect(await hashspan.flush({ timeoutMs: 50 })).toBe(true);
    expect(tracing.spans()).toHaveLength(1);
  });

  it('records nothing for a payment that a later hook aborts', async () => {
    const client = testClient();
    const hashspan = withHashspan(client);
    client.onBeforePaymentCreation(async () => ({ abort: true, reason: 'policy' }));
    await expect(
      wrapFetchWithPayment(
        paidApi(() => settledWith({})),
        client,
      )(URL_PAID),
    ).rejects.toThrow();
    expect(await hashspan.flush({ timeoutMs: 50 })).toBe(true);
    expect(tracing.spans()).toEqual([]);
  });

  it('ends a payment without a response as timeout on flush', async () => {
    const client = testClient();
    const hashspan = withHashspan(client);
    const pay = wrapFetchWithPayment(
      paidApi(() => Promise.reject(new TypeError('fetch failed'))),
      client,
    );
    await expect(pay(URL_PAID)).rejects.toThrow('fetch failed');
    expect(tracing.spans()).toEqual([]);
    expect(await hashspan.flush({ timeoutMs: 20 })).toBe(false);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
  });

  it('ends a payment without a response as timeout once its authorization expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const debug = vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const client = testClient();
    withHashspan(client);
    const late = deferred<Response>();
    let arrived = false;
    const call = wrapFetchWithPayment(
      paidApi(() => {
        arrived = true;
        return late.promise;
      }),
      client,
    )(URL_PAID);
    await vi.waitFor(() => expect(arrived).toBe(true));
    // maxTimeoutSeconds is 60; the grace period is 30 s.
    await vi.advanceTimersByTimeAsync(89_000);
    expect(tracing.spans()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['error.type']).toBe('timeout');

    late.release(settledWith({}));
    await call;
    expect(tracing.spans()).toHaveLength(1);
    expect(debug).toHaveBeenCalledWith(
      'hashspan: a payment response for no open payment span; not recording it',
    );
  });
});

describe('withHashspan()', () => {
  it('returns the first handle for a client traced twice, and records each payment once', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const client = testClient();
    const first = withHashspan(client);
    expect(withHashspan(client)).toBe(first);
    expect(warn).toHaveBeenCalledOnce();
    await wrapFetchWithPayment(
      paidApi(() => settledWith({})),
      client,
    )(URL_PAID);
    expect(tracing.spans()).toHaveLength(1);
  });

  it('records nothing and never throws when its tracker fails', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const client = testClient();
    withHashspan(client, {
      tracker: {
        startSend: () => {
          throw new Error('broken');
        },
        startConfirm: () => {
          throw new Error('broken');
        },
        startPayment: () => {
          throw new Error('broken');
        },
        startUserOperationSend: () => {
          throw new Error('broken');
        },
        startUserOperationConfirm: () => {
          throw new Error('broken');
        },
      },
    });
    const response = await wrapFetchWithPayment(
      paidApi(() => settledWith({})),
      client,
    )(URL_PAID);
    expect(response.status).toBe(200);
    expect(tracing.spans()).toEqual([]);
  });

  it('accepts requirements with any validity', async () => {
    const client = testClient();
    const hashspan = withHashspan(client);
    for (const maxTimeoutSeconds of [-1, Number.NaN, 10 ** 9]) {
      await wrapFetchWithPayment(
        paidApi(() => settledWith({}), paymentRequired({ maxTimeoutSeconds })),
        client,
      )(URL_PAID);
    }
    expect(await hashspan.flush({ timeoutMs: 50 })).toBe(true);
    expect(tracing.spans()).toHaveLength(3);
  });
});
