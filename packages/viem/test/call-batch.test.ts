import { createTxTracker, type TxTracker } from '@hashspan/core';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const BATCH_ID = '0xb47c4';
const sends = () => tracing.spans().filter((s) => s.name === 'send 8453');
const confirms = () => tracing.spans().filter((s) => s.name === 'confirm 8453');
const calls = [
  { to: TO, value: 1n },
  { to: TO, data: '0xa9059cbb' as const },
];

function wallet(options: Parameters<typeof mockTransport>[0] = {}, hashspan = withHashspan()) {
  const node = mockTransport(options);
  const client = createWalletClient({
    account: FROM,
    chain: base,
    transport: node.transport,
    pollingInterval: 10,
  }).extend(hashspan);
  return { client, node, hashspan };
}

describe('sendCalls', () => {
  it('records a send span with the sender, call count and batch id, and returns the result unchanged', async () => {
    const { client } = wallet();
    const result = await client.sendCalls({ calls });

    expect(result).toEqual({ id: BATCH_ID });
    const [send] = sends();
    expect(send?.attributes).toMatchObject({
      'blockchain.operation.name': 'send',
      'blockchain.call_batch.sender': FROM,
      'blockchain.call_batch.call_count': 2,
      'blockchain.call_batch.id': BATCH_ID,
    });
    expect(send?.attributes).not.toHaveProperty('blockchain.tx.hash');
  });

  it('records the failure and rethrows it when the wallet rejects the batch', async () => {
    const { client } = wallet({ sendCalls: { error: { code: 4001, message: 'rejected' } } });
    await expect(client.sendCalls({ calls })).rejects.toThrow();
    expect(sends()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('waitForCallsStatus', () => {
  it('records a confirm span linked to the send span, with the status code and transaction hashes', async () => {
    const { client, hashspan } = wallet({
      callsStatus: (call) => (call === 1 ? { status: 100, receipts: [] } : {}),
    });
    const { id } = await client.sendCalls({ calls });
    const status = await client.waitForCallsStatus({ id });
    await hashspan.flush();

    expect(status.status).toBe('success');
    expect(confirms()).toHaveLength(1);
    const [confirm] = confirms();
    expect(confirm?.links[0]?.context.spanId).toBe(sends()[0]?.spanContext().spanId);
    expect(confirm?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm?.attributes).toMatchObject({
      'blockchain.call_batch.id': BATCH_ID,
      'blockchain.call_batch.status_code': 200,
      'blockchain.call_batch.atomic': true,
      'blockchain.call_batch.transaction_hashes': [HASH],
      'blockchain.block.number': 123,
    });
    expect(confirm?.attributes).not.toHaveProperty('blockchain.tx.fee');
  });

  it.each([
    [500, 'reverted'],
    [600, 'partially_reverted'],
    [400, 'failed'],
  ])('ends a status %i as an error with error.type %s', async (code, errorType) => {
    const { client, hashspan } = wallet({ callsStatus: () => ({ status: code }) });
    const status = await client.waitForCallsStatus({ id: BATCH_ID });
    await hashspan.flush();

    expect(status.statusCode).toBe(code);
    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirms()[0]?.attributes['error.type']).toBe(errorType);
  });

  it('records the status a BundleFailedError carries, and passes the error on unchanged', async () => {
    const { client, hashspan } = wallet({ callsStatus: () => ({ status: 500 }) });
    await expect(
      client.waitForCallsStatus({ id: BATCH_ID, throwOnFailure: true }),
    ).rejects.toMatchObject({ name: 'BundleFailedError' });
    await hashspan.flush();

    expect(confirms()[0]?.attributes).toMatchObject({
      'error.type': 'reverted',
      'blockchain.call_batch.status_code': 500,
    });
  });

  it('ends without an outcome when the caller accepts a pending status', async () => {
    const { client, hashspan } = wallet({ callsStatus: () => ({ status: 100, receipts: [] }) });
    await client.waitForCallsStatus({ id: BATCH_ID, status: () => true });
    await hashspan.flush();

    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirms()[0]?.attributes['blockchain.call_batch.status_code']).toBe(100);
    expect(confirms()[0]?.attributes).not.toHaveProperty('error.type');
  });

  it('ends as timeout when the wait gives up, and rethrows', async () => {
    const { client, hashspan } = wallet({ callsStatus: () => ({ status: 100, receipts: [] }) });
    await expect(client.waitForCallsStatus({ id: BATCH_ID, timeout: 50 })).rejects.toMatchObject({
      name: 'WaitForCallsStatusTimeoutError',
    });
    await hashspan.flush();

    expect(confirms()[0]?.attributes['error.type']).toBe('timeout');
  });

  it('takes the chain from the status when the client has none', async () => {
    const hashspan = withHashspan();
    const client = createWalletClient({
      account: FROM,
      transport: mockTransport().transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await client.waitForCallsStatus({ id: BATCH_ID });
    await hashspan.flush();

    expect(confirms()).toHaveLength(1);
  });
});

describe('a status request that fails', () => {
  it('ends the confirm span with an error and rethrows', async () => {
    const { client, hashspan } = wallet({ failOn: ['wallet_getCallsStatus'] });
    await expect(client.waitForCallsStatus({ id: BATCH_ID, retryCount: 0 })).rejects.toThrow();
    await hashspan.flush();
    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('is recorded once the client answered its chain id, when it has no chain', async () => {
    const hashspan = withHashspan();
    const client = createWalletClient({
      account: FROM,
      transport: mockTransport({ failOn: ['wallet_getCallsStatus'] }).transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await expect(client.waitForCallsStatus({ id: BATCH_ID, retryCount: 0 })).rejects.toThrow();
    await hashspan.flush();
    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('arguments that throw when telemetry reads them', () => {
  it('leave the wait untraced, and the call works', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const { client, hashspan } = wallet();
    const args = new Proxy(
      { id: BATCH_ID },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    await expect(client.waitForCallsStatus(args)).resolves.toMatchObject({ status: 'success' });
    await hashspan.flush();
    expect(confirms()).toHaveLength(0);
  });
});

describe('sendCallsSync', () => {
  it('records one send span and one confirm span, and returns the status unchanged', async () => {
    const { client, hashspan } = wallet();
    const status = await client.sendCallsSync({ calls });
    await hashspan.flush();

    expect(status.status).toBe('success');
    expect(sends()).toHaveLength(1);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.links[0]?.context.spanId).toBe(sends()[0]?.spanContext().spanId);
  });
});

describe("viem's fallback to eth_sendTransaction", () => {
  it('records the batch and confirms its transactions in the background, linked to the batch', async () => {
    const { client, hashspan } = wallet(
      { sendCalls: { error: { code: -32601, message: 'Method not found' } } },
      withHashspan({ confirm: { mode: 'background' } }),
    );
    const { id } = await client.sendCalls({ calls, experimental_fallback: true });
    await hashspan.flush();

    expect(id.endsWith('5792'.repeat(16))).toBe(true);
    const [send] = sends();
    expect(send?.attributes['blockchain.call_batch.id']).toBe(id.slice(0, 256));
    // Both calls were sent as transactions; the mock answers them with the same hash: one confirm span.
    const [confirm] = confirms();
    expect(confirm?.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(confirm?.attributes['blockchain.tx.fee']).toBeDefined();
    expect(confirm?.links[0]?.context.spanId).toBe(send?.spanContext().spanId);
  });
});

describe('with a tracker from a core without call batches', () => {
  it('records no call batch spans, and the calls work', async () => {
    const full = createTxTracker();
    const older = {
      startSend: full.startSend,
      startConfirm: full.startConfirm,
      startPayment: full.startPayment,
      startUserOperationSend: full.startUserOperationSend,
      startUserOperationConfirm: full.startUserOperationConfirm,
    } as unknown as TxTracker;
    const { client, hashspan } = wallet({}, withHashspan({ tracker: older }));
    const status = await client.sendCallsSync({ calls });
    await hashspan.flush();

    expect(status.status).toBe('success');
    expect(tracing.spans()).toHaveLength(0);
  });
});
