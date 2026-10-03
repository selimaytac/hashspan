import { diag } from '@opentelemetry/api';
import { createPublicClient } from 'viem';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, type MockOptions, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** A client without a chain, as `createPublicClient` returns when none is given; the mock is on Base (8453). */
const chainless = (options: MockOptions = {}) =>
  createPublicClient({ transport: mockTransport(options).transport, pollingInterval: 10 });

it('confirms through a client without a chain when the client is on the chain asked for', async () => {
  const hashspan = withHashspan();
  const receipts: unknown[] = [];
  hashspan.watch(chainless(), {
    hash: HASH,
    chainId: 8453,
    onReceipt: (receipt) => receipts.push(receipt),
  });
  await hashspan.flush({ timeoutMs: 2_000 });
  expect(tracing.spans().map((s) => s.name)).toEqual(['confirm 8453']);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toBeDefined();
});

it('records nothing when a client without a chain is on another chain than the one asked for', async () => {
  const warn = vi.spyOn(diag, 'warn');
  const hashspan = withHashspan();
  const receipts: unknown[] = [];
  hashspan.watch(chainless(), {
    hash: HASH,
    chainId: 999_999,
    onReceipt: (receipt) => receipts.push(receipt),
  });
  await hashspan.flush({ timeoutMs: 2_000 });
  expect(tracing.spans()).toEqual([]);
  expect(receipts).toEqual([undefined]);
  expect(warn).toHaveBeenCalledWith(
    'hashspan: watch() got chain 999999 and a client on chain 8453; not recording it',
  );
});

it('records nothing, and still calls onReceipt, when a client without a chain never tells its chain', async () => {
  const hashspan = withHashspan();
  const receipts: unknown[] = [];
  hashspan.watch(chainless({ hangOn: ['eth_chainId'] }), {
    hash: HASH,
    chainId: 8453,
    timeoutMs: 50,
    onReceipt: (receipt) => receipts.push(receipt),
  });
  await vi.waitFor(() => expect(receipts).toEqual([undefined]));
  expect(tracing.spans()).toEqual([]);
});
