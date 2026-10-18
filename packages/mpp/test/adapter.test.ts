// The outcome table of ADR 0029, driven through a real mppx client (`Mppx.create`) and a real mppx server's challenges,
// offline: every row of what the client sees, and the payment span it gives.
import { createTxTracker } from '@hashspan/core';
import { context, diag, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, keccak256 } from 'viem';
import { tempo as tempoChain } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  CHAIN_ID,
  CONFIRM_SPAN,
  CURRENCY,
  decodeCredential,
  hashOf,
  offlineRpc,
  PAYER,
  PAYMENT_SPAN,
  paidApi,
  paidServer,
  RECIPIENT,
  receiptHeader,
  rpcReceipt,
  settled,
  testClient,
  URL_PAID,
} from './fake-mppx.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await tracing.teardown();
});

const payer = PAYER.address.toLowerCase();

/** Pays `URL_PAID` with `client` inside a tool span, and returns the response and the tool span. */
async function payInTool(
  client: ReturnType<typeof testClient>,
  input: string | URL | Request = URL_PAID,
) {
  const tool = trace.getTracer('test').startSpan('execute_tool weather');
  try {
    const response = await context.with(trace.setSpan(context.active(), tool), () =>
      client.fetch(input),
    );
    return { response, tool };
  } finally {
    tool.end();
  }
}

/** The credentials the paid API received, in order. */
const credentialsOf = (api: ReturnType<typeof paidApi>) =>
  api.paidRequests.map((request) => request.headers.get('authorization') as string);

describe('a settled payment', () => {
  it.each(['push', 'pull'] as const)(
    'is a payment span under the caller with what was paid, the mode and the settlement (%s)',
    async (mode) => {
      const api = paidApi(settled());
      const client = testClient(api.fetch, { mode });
      const hashspan = withHashspan(client);
      const { response, tool } = await payInTool(client);
      await hashspan.flush();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ temperature: 21 });
      const [credential] = credentialsOf(api);
      const span = tracing.spanNamed(PAYMENT_SPAN);
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
      expect(span.attributes).toEqual({
        'blockchain.system.name': 'evm',
        'blockchain.chain.id': CHAIN_ID,
        'blockchain.operation.name': 'payment',
        'blockchain.payment.protocol': 'mpp',
        'blockchain.payment.payer': payer,
        'blockchain.payment.recipient': RECIPIENT,
        'blockchain.payment.asset': CURRENCY,
        'blockchain.payment.amount': '10000',
        'blockchain.payment.status': 'settled',
        'blockchain.tx.hash': hashOf(credential as string),
        'mpp.method': 'tempo',
        'mpp.intent': 'charge',
        'mpp.mode': mode,
        'mpp.challenge.id': (decodeCredential(credential as string).challenge as { id: string }).id,
        'mpp.resource': 'https://api.example.com',
      });
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      // Without a reader, only the payment span.
      expect(tracing.spans().map((s) => s.name)).toEqual([PAYMENT_SPAN, 'execute_tool weather']);
    },
  );

  it('starts when the challenge came, so a push transaction sent before the credential falls inside it', async () => {
    const rpc = offlineRpc();
    const api = paidApi(settled());
    const client = testClient(api.fetch, { mode: 'push', rpc });
    const sentAt: number[] = [];
    client.onChallengeReceived(() => {
      sentAt.push(Date.now());
      return undefined;
    });
    withHashspan(client);
    const before = Date.now();
    await client.fetch(URL_PAID);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
    expect(startMs).toBeGreaterThanOrEqual(before - 1);
    expect(startMs).toBeLessThanOrEqual((sentAt[0] as number) + 1);
    expect(rpc.requests.map(({ method }) => method)).toContain('eth_sendRawTransactionSync');
  });

  it("records the reported hash of a sponsored pull, which only the server's co-signature fixes", async () => {
    const reference = `0x${'5a'.repeat(32)}`;
    const api = paidApi(
      settled(() => reference),
      paidServer({ feePayer: true }),
    );
    const client = testClient(api.fetch, { mode: 'pull' });
    const hashspan = withHashspan(client);
    await client.fetch(URL_PAID);
    await hashspan.flush();
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['mpp.mode']).toBe('pull');
    expect(span.attributes['blockchain.tx.hash']).toBe(reference);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
  });

  it("keeps the payer's own hash over another one the server reports, and marks the payment unverified", async () => {
    const reported = `0x${'77'.repeat(32)}`;
    const api = paidApi(settled(() => reported));
    const client = testClient(api.fetch, { mode: 'pull' });
    const hashspan = withHashspan(client);
    await client.fetch(URL_PAID);
    await hashspan.flush();
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.tx.hash']).toBe(hashOf(credentialsOf(api)[0] as string));
    expect(span.attributes['blockchain.payment.verified']).toBe(false);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
  });

  it('records no reported hash that is not one', async () => {
    const api = paidApi(
      settled(() => '0x1234'),
      paidServer({ feePayer: true }),
    );
    const client = testClient(api.fetch, { mode: 'pull' });
    withHashspan(client);
    await client.fetch(URL_PAID);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
  });

  it.each([
    ['a string', URL_PAID],
    ['a URL', new URL(URL_PAID)],
    ['a Request', new Request(URL_PAID)],
  ])('records the origin of the resource paid for, given as %s', async (_name, input) => {
    const api = paidApi(settled());
    const client = testClient(api.fetch);
    withHashspan(client, { paymentResource: 'path' });
    const response = await client.fetch(input as never);
    expect(response.status).toBe(200);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['mpp.resource']).toBe(
      'https://api.example.com/weather',
    );
  });
});

describe('a paid request without a settlement', () => {
  it('ends as no_settlement when the response has no Payment-Receipt', async () => {
    const api = paidApi(() => new Response('{}'));
    const client = testClient(api.fetch);
    withHashspan(client);
    const response = await client.fetch(URL_PAID);
    expect(response.status).toBe(200);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('no_settlement');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events).toEqual([]);
  });

  it.each([
    ['not base64url JSON', '%%%'],
    ['JSON that is not an object', Buffer.from('[1]').toString('base64url')],
    [
      'a receipt without status success',
      receiptHeader(`0x${'ab'.repeat(32)}`, { status: 'failed' }),
    ],
    ['longer than 4096 characters', 'a'.repeat(4097)],
  ])('ends as _OTHER for a Payment-Receipt that is %s', async (_name, header) => {
    const api = paidApi(() => new Response('{}', { headers: { 'payment-receipt': header } }));
    const client = testClient(api.fetch);
    withHashspan(client);
    const response = await client.fetch(URL_PAID);
    expect(response.status).toBe(200);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('_OTHER');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
  });
});

describe('a payment whose outcome is unknown', () => {
  it.each(['push', 'pull'] as const)(
    "is pending with the payer's hash after a 5xx (%s), resolved by the confirm span",
    async (mode) => {
      const rpc = offlineRpc();
      const api = paidApi(() => new Response('upstream failed', { status: 502 }));
      const client = testClient(api.fetch, { mode, rpc });
      const reader = createPublicClient({ chain: tempoChain, transport: rpc.transport });
      const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 2_000 });
      const response = await client.fetch(URL_PAID);
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('upstream failed');
      const hash = hashOf(credentialsOf(api)[0] as string) as `0x${string}`;
      if (mode === 'pull') rpc.mined.set(hash, rpcReceipt(hash));
      expect(await hashspan.flush()).toBe(true);
      const span = tracing.spanNamed(PAYMENT_SPAN);
      expect(span.attributes['blockchain.payment.status']).toBe('pending');
      expect(span.attributes['blockchain.tx.hash']).toBe(hash);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      const confirm = tracing.spanNamed(CONFIRM_SPAN);
      expect(confirm.attributes['blockchain.tx.status']).toBe('success');
      expect(confirm.links.map((link) => link.context.spanId)).toEqual([span.spanContext().spanId]);
    },
  );

  it("is pending with the payer's hash when the paid request throws", async () => {
    const api = paidApi(() => {
      throw new TypeError('fetch failed');
    });
    const client = testClient(api.fetch, { mode: 'pull' });
    withHashspan(client);
    await expect(client.fetch(URL_PAID)).rejects.toThrow('fetch failed');
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('pending');
    expect(span.attributes['blockchain.tx.hash']).toBe(hashOf(credentialsOf(api)[0] as string));
  });

  it('fails with the error type and no status when a sponsored pull has no hash', async () => {
    const api = paidApi(() => new Response(null, { status: 500 }), paidServer({ feePayer: true }));
    const client = testClient(api.fetch, { mode: 'pull' });
    withHashspan(client);
    await client.fetch(URL_PAID);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('PaymentOutcomeUnknownError');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('a payment that was not made', () => {
  it('fails as a failed send when the push transaction cannot be sent, with no hash', async () => {
    const api = paidApi(settled());
    const client = testClient(api.fetch, { mode: 'push', rpc: offlineRpc({ failSend: true }) });
    withHashspan(client);
    await expect(client.fetch(URL_PAID)).rejects.toThrow();
    expect(api.paidRequests).toEqual([]);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(typeof span.attributes['error.type']).toBe('string');
    expect(span.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(span.attributes['mpp.mode']).toBeUndefined();
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    expect(span.attributes['blockchain.payment.recipient']).toBe(RECIPIENT);
  });

  it('records nothing for a challenge the client refused before any observer saw it (it expired)', async () => {
    const api = paidApi(
      settled(),
      paidServer({ expires: new Date(Date.now() - 1000).toISOString() }),
    );
    const client = testClient(api.fetch);
    const failed = vi.fn();
    client.onPaymentFailed(failed);
    withHashspan(client);
    await expect(client.fetch(URL_PAID)).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(tracing.spans()).toEqual([]);
  });

  it('records nothing for a zero-amount challenge, answered with a proof, failures included', async () => {
    for (const answer of [settled(), () => new Response(null, { status: 500 })]) {
      const api = paidApi(answer, paidServer({ amount: '0' }));
      const client = testClient(api.fetch);
      const hashspan = withHashspan(client);
      await client.fetch(URL_PAID);
      expect(
        (decodeCredential(credentialsOf(api)[0] as string).payload as { type: string }).type,
      ).toBe('proof');
      expect(await hashspan.flush({ timeoutMs: 100 })).toBe(true);
    }
    expect(tracing.spans()).toEqual([]);
  });
});

describe('a paid request with no outcome event', () => {
  it.each([
    ['a 4xx', 404],
    ['a 3xx', 303],
  ])('ends as timeout once the challenge expired, after %s', async (_name, status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const api = paidApi(
      () =>
        new Response(null, {
          status,
          headers: status === 303 ? { location: '/elsewhere' } : {},
        }),
      paidServer({ expires: new Date(Date.now() + 60_000).toISOString() }),
    );
    const client = testClient(api.fetch, { mode: 'push' });
    withHashspan(client);
    const response = await client.fetch(URL_PAID);
    expect(response.status).toBe(status);
    expect(tracing.spans()).toEqual([]);
    // The challenge's validity plus the grace period.
    vi.advanceTimersByTime(60_000 + 25_000);
    expect(tracing.spans()).toEqual([]);
    vi.advanceTimersByTime(10_000);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['blockchain.payment.status']).toBeUndefined();
    // A push payment moved the money: its hash stays recorded.
    expect(span.attributes['blockchain.tx.hash']).toBe(hashOf(credentialsOf(api)[0] as string));
  });

  it('ends as timeout after a final 402, and pays the new challenge of a later round in a span of its own', async () => {
    const server = paidServer();
    let rounds = 0;
    const api = paidApi(async (credential, request) => {
      rounds += 1;
      // The first paid request is rejected with a new challenge; the second settles.
      return rounds === 1 ? server(new Request(request.url)) : settled()(credential, request);
    }, server);
    const client = testClient(api.fetch, { mode: 'pull' });
    const hashspan = withHashspan(client);
    const response = await client.fetch(URL_PAID);
    expect(response.status).toBe(200);
    expect(await hashspan.flush({ timeoutMs: 50 })).toBe(false);
    const spans = tracing.spans().filter((span) => span.name === PAYMENT_SPAN);
    expect(
      spans.map(
        (span) => span.attributes['blockchain.payment.status'] ?? span.attributes['error.type'],
      ),
    ).toEqual(['settled', 'timeout']);
    const [first, second] = credentialsOf(api).map(
      (credential) => (decodeCredential(credential).challenge as { id: string }).id,
    );
    expect(first).not.toBe(second);
    expect(spans.map((span) => span.attributes['mpp.challenge.id'])).toEqual([second, first]);
  });

  it('ends what flush() still waits for as timeout, and resolves false', async () => {
    const api = paidApi(() => new Response(null, { status: 404 }));
    const client = testClient(api.fetch, { mode: 'push' });
    const hashspan = withHashspan(client);
    await client.fetch(URL_PAID);
    expect(await hashspan.flush({ timeoutMs: 20 })).toBe(false);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['blockchain.tx.hash']).toBe(hashOf(credentialsOf(api)[0] as string));
  });
});

describe('a payment made with the manual APIs', () => {
  it('starts at the challenge and ends as timeout, since no outcome event comes', async () => {
    const client = testClient(paidApi(settled()).fetch, { mode: 'pull' });
    const hashspan = withHashspan(client);
    const challenge = await paidServer()(new Request(URL_PAID));
    const credential = await client.createCredential(challenge);
    expect(credential).toMatch(/^Payment /);
    expect(await hashspan.flush({ timeoutMs: 20 })).toBe(false);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['mpp.mode']).toBe('pull');
  });
});

describe('the client', () => {
  it('passes the same credential to the paid request as without hashspan, and the same response to the caller', async () => {
    const results: { status: number; body: string; mode: string }[] = [];
    for (const traced of [false, true]) {
      const api = paidApi(settled());
      const client = testClient(api.fetch, { mode: 'pull' });
      if (traced) withHashspan(client);
      const response = await client.fetch(URL_PAID);
      results.push({
        status: response.status,
        body: await response.text(),
        mode: (decodeCredential(credentialsOf(api)[0] as string).payload as { type: string }).type,
      });
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('traces a second client of its own, and returns the first handle with a warning for the same client', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const client = testClient(paidApi(settled()).fetch);
    const first = withHashspan(client);
    expect(withHashspan(client, { reader: undefined })).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already traced'));
    expect(withHashspan(testClient(paidApi(settled()).fetch))).not.toBe(first);
  });

  it('traces nothing with a tracker from a core without paymentSenders, with one warning', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const current = createTxTracker();
    const { paymentSenders: _senders, ...older } = current as unknown as Record<string, unknown>;
    const api = paidApi(settled());
    const client = testClient(api.fetch);
    const hashspan = withHashspan(client, { tracker: older as never });
    await client.fetch(URL_PAID);
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    expect(tracing.spans()).toEqual([]);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('paymentSenders')),
    ).toHaveLength(1);
  });

  it('shares a tracker given as an option', async () => {
    const tracker = createTxTracker();
    const startPayment = vi.spyOn(tracker, 'startPayment');
    const client = testClient(paidApi(settled()).fetch);
    withHashspan(client, { tracker });
    await client.fetch(URL_PAID);
    expect(startPayment).toHaveBeenCalledTimes(1);
    expect(startPayment.mock.calls[0]?.[0]).toMatchObject({
      protocol: 'mpp',
      sender: 'payer',
      chainId: CHAIN_ID,
    });
  });

  it('records the hash the payer computed as keccak256 of the signed transaction for a pull', async () => {
    const api = paidApi(settled());
    const client = testClient(api.fetch, { mode: 'pull' });
    withHashspan(client);
    await client.fetch(URL_PAID);
    const { payload } = decodeCredential(credentialsOf(api)[0] as string);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.tx.hash']).toBe(
      keccak256(payload.signature as `0x${string}`),
    );
  });
});
