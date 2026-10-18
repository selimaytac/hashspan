// Real MPP charges on Anvil in Tempo mode (ADR 0029): the mppx client pays an mppx server in this process, which
// verifies and settles on the local chain. Push through a traced client on a shared tracker and on a separate one,
// unsponsored and sponsored pull, splits, `verified` true and false, and a 4xx and a 5xx after payment.
import { createTxTracker } from '@hashspan/core';
import { withHashspan as withViemHashspan } from '@hashspan/viem';
import { SpanStatusCode } from '@opentelemetry/api';
import { Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { createPublicClient, http } from 'viem';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordingMeterProvider } from '../../core/test/hostile.js';
import { withHashspan } from '../src/index.js';
import {
  CHAIN_ID,
  CONFIRM_SPAN,
  chainClient,
  guardEgress,
  PAYER,
  PAYMENT_SPAN,
  paidApi,
  RECIPIENT,
  SEND_SPAN,
  type ServerOptions,
  SPLIT_RECIPIENT,
  startTempoAnvil,
  URL_PAID,
  WALLET,
} from './tempo-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const anvil = await startTempoAnvil();
const { chain } = anvil;
afterAll(async () => {
  await anvil.instance.stop();
});

let tracing: TestTracing;
let egress: { blocked: string[] };
beforeEach(() => {
  tracing = setupTracing();
  egress = guardEgress();
});
afterEach(async () => {
  await tracing.teardown();
  expect(egress.blocked).toEqual([]);
});

const reader = () =>
  createPublicClient({ chain, transport: http(anvil.rpcUrl), pollingInterval: 50 });

interface Setup {
  mode: 'push' | 'pull';
  server?: ServerOptions;
  /** `shared`: the payer's viem client and the adapter share one tracker; `separate`: each has its own. */
  tracker?: 'shared' | 'separate' | 'none';
  /** The paying account: a local one (default) or Anvil's unlocked JSON-RPC account. */
  account?: 'local' | 'json-rpc';
  /** How long flush() waits; default 15 s. */
  flushMs?: number;
  observeFailures?: boolean;
}

/** Pays `URL_PAID` once and returns the response, the spans and the fee samples. */
async function charge(setup: Setup) {
  const meters = recordingMeterProvider();
  const tracker = createTxTracker({ meterProvider: meters.provider });
  const payerViem = withViemHashspan(
    setup.tracker === 'separate' ? { meterProvider: meters.provider } : { tracker },
  );
  const base = chainClient(chain, setup.account === 'json-rpc' ? WALLET : PAYER);
  const payerClient = setup.tracker === 'none' ? base : base.extend(payerViem);
  const api = paidApi(chain, setup.server);
  const mppx = Mppx.create({
    methods: [
      tempo({
        ...(setup.account === 'json-rpc' ? {} : { account: PAYER }),
        mode: setup.mode,
        getClient: () => payerClient as never,
      }),
    ],
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      api(new Request(input, init))) as never,
    polyfill: false,
  });
  const hashspan = withHashspan(mppx, {
    reader: reader(),
    ...(setup.observeFailures ? { observeFailures: true } : {}),
    ...(setup.tracker === 'separate' ? { meterProvider: meters.provider } : { tracker }),
  });
  const response = await mppx.fetch(URL_PAID);
  const receiptHeader = response.headers.get('payment-receipt');
  const body = await response.text();
  const flushed = await hashspan.flush({ timeoutMs: setup.flushMs ?? 15_000 });
  await payerViem.flush();
  const payments = tracing.spans().filter(({ name }) => name === PAYMENT_SPAN);
  return {
    response,
    body,
    reference: receiptHeader ? Receipt.deserialize(receiptHeader).reference : undefined,
    flushed,
    payment: payments[0],
    payments,
    confirms: tracing.spans().filter(({ name }) => name === CONFIRM_SPAN),
    sends: tracing.spans().filter(({ name }) => name === SEND_SPAN),
    feePayers: meters
      .samples()
      .filter(({ name }) => name === 'blockchain.client.fee')
      .map(({ attributes }) => attributes['blockchain.fee.payer']),
  };
}

describe('push', () => {
  it('links the payment span to the send span on a shared tracker, with one confirm span and a verdict', async () => {
    const run = await charge({ mode: 'push', tracker: 'shared' });
    expect(run.response.status).toBe(200);
    expect(run.flushed).toBe(true);
    const [send] = run.sends;
    expect(run.sends).toHaveLength(1);
    expect(run.confirms).toHaveLength(1);
    const hash = send?.attributes['blockchain.tx.hash'];
    expect(run.reference).toBe(hash);
    expect(run.payment?.attributes).toMatchObject({
      'blockchain.payment.protocol': 'mpp',
      'mpp.mode': 'push',
      'blockchain.payment.status': 'settled',
      'blockchain.payment.verified': true,
      'blockchain.tx.hash': hash,
      'blockchain.payment.recipient': RECIPIENT,
    });
    // The payment span and the payer's send and confirm spans point at each other.
    expect(run.payment?.links.map((link) => link.context.spanId)).toEqual([
      send?.spanContext().spanId,
    ]);
    expect(run.confirms[0]?.links.map((link) => link.context.spanId)).toEqual([
      send?.spanContext().spanId,
    ]);
    // The payer paid its own fee: no fee payer, and never `facilitator`.
    expect(run.feePayers).toEqual([undefined]);
  });

  it('records a second confirm span and fee sample on a separate tracker, and no link to the send span', async () => {
    const run = await charge({ mode: 'push', tracker: 'separate' });
    expect(run.response.status).toBe(200);
    expect(run.sends).toHaveLength(1);
    expect(run.confirms).toHaveLength(2);
    expect(run.payment?.links).toEqual([]);
    expect(run.payment?.attributes['blockchain.payment.verified']).toBe(true);
    expect(run.feePayers).toEqual([undefined, undefined]);
  });

  it("pays from a JSON-RPC account with sendCallsSync, linked to the call batch's send span", async () => {
    // viem falls back to eth_sendTransaction for a single call on a node without wallet_sendCalls, as Anvil is.
    const run = await charge({ mode: 'push', tracker: 'shared', account: 'json-rpc' });
    expect(run.response.status).toBe(200);
    expect(run.payment?.attributes['mpp.mode']).toBe('push');
    expect(run.payment?.attributes['blockchain.tx.hash']).toBe(run.reference);
    expect(run.payment?.attributes['blockchain.payment.verified']).toBe(true);
    const [batch] = run.sends;
    expect(run.sends).toHaveLength(1);
    expect(batch?.attributes['blockchain.call_batch.id']).toBeDefined();
    expect(run.payment?.links.map((link) => link.context.spanId)).toEqual([
      batch?.spanContext().spanId,
    ]);
    // The transaction's confirm span, linked to the batch's send span, beside the batch's own confirm span.
    const transaction = run.confirms.find(
      (span) => span.attributes['blockchain.tx.hash'] === run.reference,
    );
    expect(transaction?.links.map((link) => link.context.spanId)).toEqual([
      batch?.spanContext().spanId,
    ]);
  });
});

describe('pull', () => {
  it("confirms the server's broadcast of the payer's transaction, with a verdict and the payer's fee", async () => {
    const run = await charge({ mode: 'pull' });
    const mined = await reader().getTransaction({ hash: run.reference as `0x${string}` });
    expect(mined.from.toLowerCase()).toBe(PAYER.address.toLowerCase());
    expect(run.response.status).toBe(200);
    expect(run.sends).toEqual([]);
    expect(run.confirms).toHaveLength(1);
    const hash = run.payment?.attributes['blockchain.tx.hash'];
    expect(hash).toBe(run.reference);
    expect(run.payment?.attributes['blockchain.payment.verified']).toBe(true);
    expect(run.confirms[0]?.links.map((link) => link.context.spanId)).toEqual([
      run.payment?.spanContext().spanId,
    ]);
    expect(run.feePayers).toEqual([undefined]);
  });

  it('takes the hash of a sponsored pull from the receipt, and labels its fee sponsor', async () => {
    const run = await charge({ mode: 'pull', server: { feePayer: true } });
    expect(run.response.status).toBe(200);
    expect(run.payment?.attributes['blockchain.tx.hash']).toBe(run.reference);
    expect(run.payment?.attributes['blockchain.payment.verified']).toBe(true);
    expect(run.feePayers).toEqual(['sponsor']);
  });

  it('checks every transfer of a charge with splits', async () => {
    const run = await charge({
      mode: 'pull',
      server: {
        amount: '0.03',
        splits: [{ amount: '0.01', recipient: SPLIT_RECIPIENT }],
      },
    });
    expect(run.response.status).toBe(200);
    expect(run.payment?.attributes['blockchain.payment.amount']).toBe('30000');
    expect(run.payment?.attributes['blockchain.payment.verified']).toBe(true);
  });
});

describe('a server that reports another transaction of the same payer, recipient and amount', () => {
  it.each([
    ['an unsponsored pull: the payer knows its own hash', false],
    ['a sponsored pull: the memo binds the transfer to the challenge', true],
  ])('is verified false for %s', async (_name, feePayer) => {
    const earlier = await charge({ mode: 'pull', server: { feePayer } });
    expect(earlier.payment?.attributes['blockchain.payment.verified']).toBe(true);
    const reported = earlier.reference as string;
    tracing.exporter.reset();
    const run = await charge({
      mode: 'pull',
      server: {
        feePayer,
        // Reports the earlier transaction, as settled, without settling this payment.
        instead: () =>
          new Response('{}', {
            headers: {
              'payment-receipt': Receipt.serialize({
                method: 'tempo',
                reference: reported,
                status: 'success',
                timestamp: new Date().toISOString(),
              } as never),
            },
          }),
      },
    });
    expect(run.response.status).toBe(200);
    expect(run.payment?.attributes['blockchain.payment.status']).toBe('settled');
    expect(run.payment?.attributes['blockchain.payment.verified']).toBe(false);
  });
});

describe('a paid request answered with an error after the charge settled', () => {
  it('ends as timeout after a 4xx, and keeps the hash of a push payment', async () => {
    const run = await charge({
      mode: 'push',
      server: { after: () => new Response('gone', { status: 404 }) },
      flushMs: 500,
    });
    expect(run.response.status).toBe(404);
    expect(run.flushed).toBe(false);
    expect(run.payment?.attributes['error.type']).toBe('timeout');
    expect(run.payment?.attributes['blockchain.payment.status']).toBeUndefined();
    expect(run.payment?.attributes['blockchain.tx.hash']).toBe(
      run.sends[0]?.attributes['blockchain.tx.hash'],
    );
  });

  it("ends as timeout after a 5xx by default, once the challenge expired, keeping the payer's hash, and confirms it", async () => {
    // A challenge valid for 8 s: the payment's deadline is that plus the 30 s grace period.
    const run = await charge({
      mode: 'pull',
      server: { after: () => new Response('failed', { status: 500 }), expiresInMs: 8_000 },
      flushMs: 50_000,
    });
    expect(run.response.status).toBe(500);
    expect(run.body).toBe('failed');
    expect(run.flushed).toBe(true);
    expect(run.payment?.attributes['error.type']).toBe('timeout');
    const hash = run.payment?.attributes['blockchain.tx.hash'];
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const [confirm] = run.confirms;
    expect(confirm?.attributes['blockchain.tx.hash']).toBe(hash);
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
    expect(confirm?.links.map((link) => link.context.spanId)).toEqual([
      run.payment?.spanContext().spanId,
    ]);
  }, 70_000);

  it('is pending after a 5xx with observeFailures, and the confirm span records the settled transaction', async () => {
    const run = await charge({
      mode: 'pull',
      server: { after: () => new Response('failed', { status: 500 }) },
      observeFailures: true,
    });
    expect(run.response.status).toBe(500);
    expect(run.flushed).toBe(true);
    expect(run.payment?.attributes['blockchain.payment.status']).toBe('pending');
    expect(run.payment?.status.code).toBe(SpanStatusCode.UNSET);
    const [confirm] = run.confirms;
    expect(confirm?.attributes['blockchain.tx.hash']).toBe(
      run.payment?.attributes['blockchain.tx.hash'],
    );
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
    expect(confirm?.attributes['blockchain.tx.fee_asset']).toBeDefined();
    expect(CHAIN_ID).toBe(chain.id);
  });
});
