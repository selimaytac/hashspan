// The copies of responses mppx hands to observers (ADR 0029): the adapter reads only the `Payment-Receipt` header of
// the paid response's copy, and releases the copy after the event's observers ran unless someone reads it, so a long or
// streamed paid response is not buffered for as long as the caller reads it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { hashOf, PAYMENT_SPAN, paidApi, receiptHeader, testClient, URL_PAID } from './fake-mppx.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const CHUNKS = 40;
const chunk = (index: number) => `${String(index).padStart(4, '0')}:${'x'.repeat(1019)}`;
const fullBody = Array.from({ length: CHUNKS }, (_, index) => chunk(index)).join('');

/** A paid response whose body streams `CHUNKS` chunks, one every few milliseconds. */
function streamed(credential: string): Response {
  let index = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (index >= CHUNKS) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk(index++)));
    },
  });
  return new Response(body, {
    headers: { 'payment-receipt': receiptHeader(hashOf(credential)) },
  });
}

describe("the paid response's copy", () => {
  it('is released while the caller reads the original to the end', async () => {
    const api = paidApi(streamed);
    const client = testClient(api.fetch);
    withHashspan(client);
    // An observer of the user's that keeps the copy without reading it.
    let copy: Response | undefined;
    client.onPaymentResponse(({ response }) => {
      copy = response;
    });
    const response = await client.fetch(URL_PAID);
    expect(await response.text()).toBe(fullBody);
    expect(copy).toBeInstanceOf(Response);
    // Cancelled, so it buffered nothing: reading it ends at once.
    const read = await (copy as Response).body?.getReader().read();
    expect(read).toEqual({ done: true, value: undefined });
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.status']).toBe('settled');
  });

  it("is left to an observer of the user's, registered after hashspan's, that reads it", async () => {
    const api = paidApi(streamed);
    const client = testClient(api.fetch);
    withHashspan(client);
    let copied: Promise<string> | undefined;
    client.onPaymentResponse(({ response }) => {
      copied = response.text();
    });
    const response = await client.fetch(URL_PAID);
    const [original, copy] = await Promise.all([response.text(), copied]);
    expect(original).toBe(fullBody);
    expect(copy).toBe(fullBody);
  });

  it('is found cancelled by an observer that starts reading it only later', async () => {
    const api = paidApi(streamed);
    const client = testClient(api.fetch);
    withHashspan(client);
    let later: Promise<unknown> | undefined;
    client.onPaymentResponse(({ response }) => {
      later = new Promise((resolve) => setTimeout(resolve, 20))
        .then(() => response.text())
        .catch((error: unknown) => error);
    });
    const response = await client.fetch(URL_PAID);
    expect(await response.text()).toBe(fullBody);
    // A cancelled body is disturbed: reading it rejects, as for a body read before.
    expect(await later).toBeInstanceOf(TypeError);
  });

  it('is cancelled even when the paid response has no Payment-Receipt', async () => {
    const api = paidApi((credential) => {
      const response = streamed(credential);
      return new Response(response.body);
    });
    const client = testClient(api.fetch);
    withHashspan(client);
    let copy: Response | undefined;
    client.onPaymentResponse(({ response }) => {
      copy = response;
    });
    const response = await client.fetch(URL_PAID);
    expect(await response.text()).toBe(fullBody);
    expect(await copy?.body?.getReader().read()).toEqual({ done: true, value: undefined });
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['error.type']).toBe('no_settlement');
  });
});

describe('a 5xx paid response', () => {
  /** What the caller gets for a paid request answered with `answer`: untraced, traced, or traced with `observeFailures`. */
  async function outcomes(answer: () => Response) {
    const results: { status?: number; body?: string; truncated?: string | null; threw?: string }[] =
      [];
    for (const traced of ['no', 'default', 'observeFailures'] as const) {
      const api = paidApi(answer);
      const client = testClient(api.fetch);
      if (traced === 'default') withHashspan(client);
      if (traced === 'observeFailures') withHashspan(client, { observeFailures: true });
      let response: Response;
      try {
        response = await client.fetch(URL_PAID);
      } catch (error) {
        results.push({ threw: `fetch: ${(error as Error).name}` });
        continue;
      }
      const result: (typeof results)[number] = {
        status: response.status,
        truncated: response.headers.get('mppx-body-truncated'),
      };
      try {
        result.body = await response.text();
      } catch (error) {
        result.threw = `body: ${(error as Error).name}`;
      }
      results.push(result);
    }
    return results;
  }

  it('reaches the caller byte for byte as without hashspan, by default, also when longer than 64 KiB', async () => {
    const big = 'e'.repeat(70 * 1024);
    const [untraced, traced, observing] = await outcomes(() => new Response(big, { status: 500 }));
    expect(untraced).toEqual({ status: 500, body: big, truncated: null });
    expect(traced).toEqual(untraced);
    // With observeFailures, mppx buffers the error body for the observer and cuts it at 64 KiB.
    expect(observing).toEqual({ status: 500, body: 'e'.repeat(64 * 1024), truncated: 'true' });
  });

  it('with a body stream that fails reaches the caller as without hashspan, by default', async () => {
    const failing = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            controller.error(new Error('stream broke'));
          },
        }),
        { status: 502 },
      );
    const [untraced, traced, observing] = await outcomes(failing);
    expect(untraced?.status).toBe(502);
    expect(traced).toEqual(untraced);
    // With observeFailures, mppx reads the stream for the observer and the failure rejects the call.
    expect(observing).not.toEqual(untraced);
  });
});
