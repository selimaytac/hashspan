import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
  vi.spyOn(diag, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** A rejection whose `name` cannot be read: its getter throws. */
function unreadableRejection(): Error {
  return new Proxy(new Error('wait failed'), {
    get(target, key, receiver) {
      if (key === 'name') throw new Error('trap');
      return Reflect.get(target, key, receiver);
    },
  });
}

const confirms = () => tracing.spans().filter((s) => s.name === 'confirm 8453');

/** The confirm span ended, with error status and `error.type` `_OTHER`, and no exception event. */
function expectEndedAsOther(): void {
  expect(confirms()).toHaveLength(1);
  const [confirm] = confirms();
  expect(confirm?.status.code).toBe(SpanStatusCode.ERROR);
  expect(confirm?.attributes['error.type']).toBe('_OTHER');
  expect(confirm?.events).toHaveLength(0);
}

describe('a rejected wait whose name cannot be read', () => {
  it('ends the confirm span of a transaction as _OTHER and passes the rejection on', async () => {
    const rejection = unreadableRejection();
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport })
      .extend(() => ({
        waitForTransactionReceipt: async () => {
          throw rejection;
        },
      }))
      .extend(hashspan);

    await expect(reader.waitForTransactionReceipt({ hash: HASH })).rejects.toBe(rejection);
    await expect(hashspan.flush({ timeoutMs: 1_000 })).resolves.toBe(true);
    expectEndedAsOther();
  });

  it('ends the confirm span of a user operation as _OTHER and passes the rejection on', async () => {
    const rejection = unreadableRejection();
    const hashspan = withHashspan();
    const bundler = createPublicClient({ chain: base, transport: mockTransport().transport })
      .extend(() => ({
        waitForUserOperationReceipt: async (_: { hash: string }) => {
          throw rejection;
        },
      }))
      .extend(hashspan);

    await expect(bundler.waitForUserOperationReceipt({ hash: HASH })).rejects.toBe(rejection);
    await expect(hashspan.flush({ timeoutMs: 1_000 })).resolves.toBe(true);
    expectEndedAsOther();
  });

  it('ends the confirm span of a call batch as _OTHER and passes the rejection on', async () => {
    const rejection = unreadableRejection();
    const hashspan = withHashspan();
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    })
      .extend(() => ({
        waitForCallsStatus: async () => {
          throw rejection;
        },
      }))
      .extend(hashspan);

    await expect(wallet.waitForCallsStatus({ id: '0xb47c4' })).rejects.toBe(rejection);
    await expect(hashspan.flush({ timeoutMs: 1_000 })).resolves.toBe(true);
    expectEndedAsOther();
  });
});
