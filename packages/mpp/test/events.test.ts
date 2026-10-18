// How the adapter follows one payment through the client's events: correlation by challenge id (the payloads are
// copies), repeated ids and credentials, the bounds in time and number, and what it leaves untraced.
import { diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  challengeOf,
  credentialFor,
  fakeClient,
  PAYMENT_SPAN,
  paidApi,
  receiptHeader,
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

const HASH = `0x${'9f'.repeat(32)}`;
const paidResponse = (reference = HASH) =>
  new Response('{}', { headers: { 'payment-receipt': receiptHeader(reference) } });

/** Emits the events of one paid request for `challenge`, as mppx does, ending with `payment.response`. */
async function pay(
  fake: ReturnType<typeof fakeClient>,
  challenge = challengeOf(),
  credential = credentialFor(challenge),
) {
  await fake.emit('challenge.received', { challenge, input: URL_PAID });
  await fake.emit('credential.created', { challenge, credential, input: URL_PAID });
  await fake.emit('payment.response', {
    challenge,
    credential,
    input: URL_PAID,
    response: paidResponse(),
  });
}

describe('the observers', () => {
  it('are registered with on() for the four events with observeFailures, and challenge.received never supplies a credential', async () => {
    const fake = fakeClient();
    withHashspan(fake.client, { observeFailures: true });
    expect([...fake.handlers.keys()].sort()).toEqual([
      'challenge.received',
      'credential.created',
      'payment.failed',
      'payment.response',
    ]);
    const challenge = challengeOf();
    expect(await fake.emit('challenge.received', { challenge })).toEqual([undefined]);
    // Also when the payload cannot be read.
    expect(await fake.emit('challenge.received', null)).toEqual([undefined]);
    expect(
      await fake.emit('challenge.received', {
        get challenge() {
          throw new Error('boom');
        },
      }),
    ).toEqual([undefined]);
  });

  it('get copies of the challenge in every event, so a payment is followed by its challenge id', async () => {
    const seen: { name: string; challenge: unknown }[] = [];
    const api = paidApi(settled());
    const client = testClient(api.fetch);
    withHashspan(client);
    client.on('*', (event) => {
      const { name, payload } = event as { name: string; payload: { challenge?: unknown } };
      seen.push({ name, challenge: payload.challenge });
    });
    await client.fetch(URL_PAID);
    const [received, created, response] = seen;
    expect(seen.map(({ name }) => name)).toEqual([
      'challenge.received',
      'credential.created',
      'payment.response',
    ]);
    expect(received?.challenge).not.toBe(created?.challenge);
    expect(created?.challenge).not.toBe(response?.challenge);
    expect(new Set(seen.map(({ challenge }) => (challenge as { id: string }).id)).size).toBe(1);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.status']).toBe('settled');
  });
});

describe('correlation by challenge id', () => {
  it('keeps the first start time of a repeated challenge.received', async () => {
    const fake = fakeClient();
    withHashspan(fake.client);
    const challenge = challengeOf();
    await fake.emit('challenge.received', { challenge });
    const first = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pay(fake, challenge);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toBeLessThanOrEqual(first + 1);
  });

  it('starts no second span for a second credential of an open challenge id, and joins events of the first', async () => {
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    const challenge = challengeOf();
    const credential = credentialFor(challenge);
    const other = credentialFor(challenge, { type: 'hash', hash: `0x${'aa'.repeat(32)}` });
    await fake.emit('challenge.received', { challenge });
    await fake.emit('credential.created', { challenge, credential });
    await fake.emit('credential.created', { challenge, credential: other });
    // An outcome for the second credential is not this payment's.
    await fake.emit('payment.response', { challenge, credential: other, response: paidResponse() });
    expect(tracing.spans()).toEqual([]);
    await fake.emit('payment.response', { challenge, credential, response: paidResponse() });
    // A later outcome for the same credential changes nothing.
    await fake.emit('payment.failed', { challenge, error: new Error('late') });
    await hashspan.flush();
    const spans = tracing.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(spans[0]?.attributes['blockchain.payment.status']).toBe('settled');
  });

  it('gives a server that repeats a challenge id one span per payment it opens', async () => {
    const fake = fakeClient();
    withHashspan(fake.client);
    const challenge = challengeOf();
    await pay(fake, challenge);
    await pay(fake, challenge);
    expect(tracing.spans()).toHaveLength(2);
  });

  it('ignores credentials and outcomes for a challenge it saw no challenge.received for', async () => {
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    const challenge = challengeOf();
    const credential = credentialFor(challenge);
    await fake.emit('credential.created', { challenge, credential });
    await fake.emit('payment.response', { challenge, credential, response: paidResponse() });
    await fake.emit('payment.failed', { challenge, error: new Error('x') });
    expect(await hashspan.flush()).toBe(true);
    expect(tracing.spans()).toEqual([]);
  });
});

describe('what is traced', () => {
  it.each([
    ['another method', { method: 'stripe' }, 'stripe.charge'],
    ['another intent', { intent: 'session' }, 'tempo.session'],
    ['a method that is not a short identifier', { method: 'x'.repeat(100) }, 'an unknown method'],
  ])(
    'passes %s through untraced, with one diag message per method and intent',
    async (_name, overrides, named) => {
      const debug = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const fake = fakeClient();
      withHashspan(fake.client);
      const challenge = challengeOf(overrides);
      await pay(fake, challenge);
      await pay(fake, challenge);
      expect(tracing.spans()).toEqual([]);
      const messages = debug.mock.calls.map(([message]) => String(message));
      expect(messages.filter((message) => message.includes('not tracing'))).toHaveLength(1);
      expect(messages.some((message) => message.includes(named))).toBe(true);
    },
  );

  it('traces a challenge id of up to 1024 characters, recording it only up to 128, and none longer', async () => {
    const fake = fakeClient();
    withHashspan(fake.client);
    await pay(fake, challengeOf({ id: 'a'.repeat(128) }));
    await pay(fake, challengeOf({ id: 'b'.repeat(1024) }));
    await pay(fake, challengeOf({ id: 'c'.repeat(1025) }));
    await pay(fake, challengeOf({ id: '' }));
    await pay(fake, challengeOf({ id: 42 }));
    const spans = tracing.spans();
    expect(spans.map((span) => span.attributes['mpp.challenge.id'])).toEqual([
      'a'.repeat(128),
      undefined,
    ]);
  });

  it('takes the chain and the payer from the source the payer wrote, else the chain from the challenge', async () => {
    const fake = fakeClient();
    withHashspan(fake.client);
    const challenge = challengeOf();
    await pay(
      fake,
      challenge,
      credentialFor(
        challenge,
        undefined,
        'did:pkh:eip155:42431:0x1111111111111111111111111111111111111111',
      ),
    );
    await pay(fake, challenge, credentialFor(challenge, undefined, null));
    await pay(fake, challenge, credentialFor(challenge, undefined, 'did:pkh:eip155:0:0x11'));
    const spans = tracing.spans();
    expect(spans.map((span) => span.name)).toEqual(['payment 42431', PAYMENT_SPAN, PAYMENT_SPAN]);
    expect(spans.map((span) => span.attributes['blockchain.payment.payer'])).toEqual([
      '0x1111111111111111111111111111111111111111',
      undefined,
      undefined,
    ]);
  });

  it('records no amount that is not a decimal, and still traces the payment', async () => {
    const fake = fakeClient();
    withHashspan(fake.client);
    const base = challengeOf();
    await pay(fake, { ...base, request: { ...(base.request as object), amount: '1e3' } });
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.amount']).toBeUndefined();
  });
});

describe('bounds in time and number', () => {
  it('waits the default validity of 25 seconds plus the grace period for a challenge without expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = fakeClient();
    withHashspan(fake.client);
    const challenge = challengeOf();
    await fake.emit('challenge.received', { challenge });
    await fake.emit('credential.created', { challenge, credential: credentialFor(challenge) });
    vi.advanceTimersByTime(25_000 + 30_000 - 1);
    expect(tracing.spans()).toEqual([]);
    vi.advanceTimersByTime(2);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('timeout');
    expect(span.attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it.each([
    ['an expiry over an hour away', new Date(Date.now() + 24 * 3600_000).toISOString(), 3600_000],
    ['an expiry in the past', new Date(Date.now() - 3600_000).toISOString(), 30_000],
    ['an expiry that is not a date', 'tomorrow', 55_000],
  ])(
    'waits at most an hour, and at least the grace period, for %s',
    async (_name, expires, waitMs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const fake = fakeClient();
      withHashspan(fake.client);
      const challenge = challengeOf({ expires });
      await fake.emit('challenge.received', { challenge });
      await fake.emit('credential.created', { challenge, credential: credentialFor(challenge) });
      vi.advanceTimersByTime(waitMs - 1_000);
      expect(tracing.spans()).toEqual([]);
      vi.advanceTimersByTime(1_000 + 1);
      expect(tracing.spanNamed(PAYMENT_SPAN).attributes['error.type']).toBe('timeout');
    },
  );

  it('forgets a challenge that got no credential by its deadline, and records nothing for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    const challenge = challengeOf();
    await fake.emit('challenge.received', { challenge });
    vi.advanceTimersByTime(60_000);
    await fake.emit('credential.created', { challenge, credential: credentialFor(challenge) });
    vi.useRealTimers();
    expect(await hashspan.flush()).toBe(true);
    expect(tracing.spans()).toEqual([]);
  });

  it('keeps at most 1000 payments open, counting challenges without a credential, and ends the oldest as timeout', async () => {
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    // One payment with a span, then 999 challenges only, then one more.
    const first = challengeOf({ id: 'payment-0' });
    await fake.emit('challenge.received', { challenge: first });
    await fake.emit('credential.created', { challenge: first, credential: credentialFor(first) });
    for (let index = 1; index < 1000; index++) {
      await fake.emit('challenge.received', { challenge: challengeOf({ id: `payment-${index}` }) });
    }
    expect(tracing.spans()).toEqual([]);
    await fake.emit('challenge.received', { challenge: challengeOf({ id: 'payment-1000' }) });
    const [evicted] = tracing.spans();
    expect(evicted?.attributes['mpp.challenge.id']).toBe('payment-0');
    expect(evicted?.attributes['error.type']).toBe('timeout');
    // The next one evicts a challenge without a credential: nothing is recorded for it.
    await fake.emit('challenge.received', { challenge: challengeOf({ id: 'payment-1001' }) });
    const second = challengeOf({ id: 'payment-1' });
    await fake.emit('credential.created', { challenge: second, credential: credentialFor(second) });
    // No open payment has a span: flush() does not wait for the challenges that never got a credential.
    expect(await hashspan.flush({ timeoutMs: 10 })).toBe(true);
    expect(tracing.spans()).toHaveLength(1);
  });

  it('does not make flush() wait for a challenge that was never paid, which it still drops at its deadline', async () => {
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    // A challenge the client refuses (its policy or spending limit): no credential, no span, an hour to expire.
    const unpaid = challengeOf({
      id: 'unpaid',
      expires: new Date(Date.now() + 3600_000).toISOString(),
    });
    await fake.emit('challenge.received', { challenge: unpaid });
    const started = Date.now();
    expect(await hashspan.flush({ timeoutMs: 500 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
    expect(tracing.spans()).toEqual([]);
    // The challenge is still followed: a credential created after flush() starts its span.
    await fake.emit('credential.created', { challenge: unpaid, credential: credentialFor(unpaid) });
    await fake.emit('payment.response', {
      challenge: unpaid,
      credential: credentialFor(unpaid),
      response: paidResponse(),
    });
    expect(await hashspan.flush({ timeoutMs: 500 })).toBe(true);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.status']).toBe('settled');
  });

  it('makes flush() wait for a payment with a span while an unpaid challenge is open', async () => {
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    await fake.emit('challenge.received', { challenge: challengeOf({ id: 'unpaid' }) });
    const paid = challengeOf({ id: 'paid' });
    await fake.emit('challenge.received', { challenge: paid });
    await fake.emit('credential.created', { challenge: paid, credential: credentialFor(paid) });
    setTimeout(() => {
      void fake.emit('payment.response', {
        challenge: paid,
        credential: credentialFor(paid),
        response: paidResponse(),
      });
    }, 50);
    expect(await hashspan.flush({ timeoutMs: 2_000 })).toBe(true);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.status']).toBe('settled');
  });

  it('keeps following an unpaid challenge, until its deadline, after a flush() that timed out on another payment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client);
    const unpaid = challengeOf({ id: 'unpaid' });
    await fake.emit('challenge.received', { challenge: unpaid });
    const paid = challengeOf({ id: 'paid' });
    await fake.emit('challenge.received', { challenge: paid });
    await fake.emit('credential.created', { challenge: paid, credential: credentialFor(paid) });
    const flushed = hashspan.flush({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await flushed).toBe(false);
    // Only the paid one ended, as timeout; the unpaid challenge waits for its deadline.
    expect(tracing.spans()).toHaveLength(1);
    await fake.emit('credential.created', { challenge: unpaid, credential: credentialFor(unpaid) });
    await vi.advanceTimersByTimeAsync(25_000 + 30_000);
    expect(tracing.spans()).toHaveLength(2);
    expect(tracing.spans()[1]?.attributes['error.type']).toBe('timeout');
  });

  it('ends a challenge that failed before its credential as a failed payment, with observeFailures', async () => {
    const fake = fakeClient();
    const hashspan = withHashspan(fake.client, { observeFailures: true });
    const challenge = challengeOf();
    await fake.emit('challenge.received', { challenge });
    await fake.emit('payment.failed', { challenge, error: new RangeError('spending limit') });
    expect(await hashspan.flush({ timeoutMs: 10 })).toBe(true);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['error.type']).toBe('RangeError');
    expect(span.attributes['blockchain.payment.payer']).toBeUndefined();
    expect(span.attributes['blockchain.payment.recipient']).toBeDefined();
  });
});
