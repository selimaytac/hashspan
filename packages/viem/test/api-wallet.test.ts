// A transaction a wallet service sends through its own API: the API call wrapped in a send span of the tracker that
// watch() shares, so the confirm span links to it, as packages/viem/README.md ("Transactions sent elsewhere") shows.
import { createTxTracker } from '@hashspan/core';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const API_DELAY_MS = 40;
const toMs = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);

/** A wallet service's API: it queues the transaction and answers with its hash later, or fails. */
const walletApi = (fail = false) => ({
  async send(): Promise<{ transactionHash: `0x${string}` }> {
    await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
    if (fail) throw new Error('policy denied');
    return { transactionHash: HASH };
  },
});

/** The README recipe, with the mock node as reader and `api` as the wallet service. */
async function sendThroughApi(api: ReturnType<typeof walletApi>) {
  const tracker = createTxTracker();
  const hashspan = withHashspan({ tracker });
  const reader = createPublicClient({ chain: base, transport: mockTransport().transport });

  const send = tracker.startSend({ chainId: base.id, from: FROM, to: TO, value: 5n });
  let hash: `0x${string}`;
  try {
    ({ transactionHash: hash } = await context.with(send.context, () => api.send()));
    send.end({ hash });
  } catch (error) {
    send.fail(error);
    throw error;
  }
  hashspan.watch(reader, { hash });
  return hashspan;
}

describe('a wallet service that sends through its API', () => {
  it('gets a send span over the API call and a linked confirm span under the same parent', async () => {
    const job = trace.getTracer('test').startSpan('payout');
    const hashspan = await context.with(trace.setSpan(context.active(), job), () =>
      sendThroughApi(walletApi()),
    );
    job.end();
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(send.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
    expect(confirm.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': FROM,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '5',
    });
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
    // The send span covers the service's queue: at least the API's delay.
    expect(toMs(send.endTime) - toMs(send.startTime)).toBeGreaterThanOrEqual(API_DELAY_MS - 5);
  });

  it('records a failed API call on the send span, and nothing to confirm', async () => {
    await expect(sendThroughApi(walletApi(true))).rejects.toThrow('policy denied');

    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().filter((span) => span.name.startsWith('confirm '))).toHaveLength(0);
  });
});
