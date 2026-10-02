import { diag } from '@opentelemetry/api';
import { createPublicClient, createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const confirmSpans = () => tracing.spans().filter((s) => s.name === 'confirm 8453');
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
/** A client on which no transaction is ever mined, so every background confirmation keeps polling. */
const pendingForever = () =>
  createPublicClient({
    chain: base,
    transport: mockTransport({ receipt: null }).transport,
    pollingInterval: 10,
  });
const limitWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter(([message]) => String(message).includes('maxBackgroundConfirmations'));

it('confirms no more than maxBackgroundConfirmations at once, warning once', async () => {
  const warn = vi.spyOn(diag, 'warn');
  const hashspan = withHashspan({ maxBackgroundConfirmations: 2 });
  const client = pendingForever();
  const receipts: unknown[] = [];

  for (let n = 1; n <= 4; n++) {
    hashspan.watch(client, {
      hash: hash(n),
      timeoutMs: 100,
      onReceipt: (receipt) => receipts.push(receipt),
    });
  }
  // The two over the limit are told at once that no receipt will come.
  expect(receipts).toEqual([undefined, undefined]);
  expect(limitWarnings(warn)).toHaveLength(1);

  await hashspan.flush({ timeoutMs: 2_000 });
  expect(confirmSpans().map((s) => s.attributes['blockchain.tx.hash'])).toEqual([hash(1), hash(2)]);
});

it('confirms again once a background confirmation ended', async () => {
  const warn = vi.spyOn(diag, 'warn');
  const hashspan = withHashspan({ maxBackgroundConfirmations: 1 });
  const client = pendingForever();

  hashspan.watch(client, { hash: hash(1), timeoutMs: 50 });
  hashspan.watch(client, { hash: hash(2), timeoutMs: 50 });
  await hashspan.flush({ timeoutMs: 2_000 });
  hashspan.watch(client, { hash: hash(3), timeoutMs: 50 });
  hashspan.watch(client, { hash: hash(4), timeoutMs: 50 });
  await hashspan.flush({ timeoutMs: 2_000 });

  expect(confirmSpans().map((s) => s.attributes['blockchain.tx.hash'])).toEqual([hash(1), hash(3)]);
  // Reported again after the count went back below the limit.
  expect(limitWarnings(warn)).toHaveLength(2);
});

it("does not count or limit the caller's own waits", async () => {
  const hashspan = withHashspan({
    confirm: { mode: 'background' },
    maxBackgroundConfirmations: 0,
  });
  const wallet = createWalletClient({
    account: FROM,
    chain: base,
    transport: mockTransport().transport,
    pollingInterval: 10,
  }).extend(hashspan);

  const sent = await wallet.sendTransaction({ to: TO });
  await hashspan.flush();
  expect(confirmSpans()).toHaveLength(0);

  const reader = createPublicClient({
    chain: base,
    transport: mockTransport().transport,
    pollingInterval: 10,
  }).extend(hashspan);
  await reader.waitForTransactionReceipt({ hash: sent });
  await hashspan.flush();
  expect(confirmSpans()).toHaveLength(1);
  expect(confirmSpans()[0]?.attributes['blockchain.tx.hash']).toBe(HASH);
});

it.each([-1, Number.NaN, '3'])('uses the default limit for %s', async (value) => {
  const hashspan = withHashspan({ maxBackgroundConfirmations: value as never });
  const client = pendingForever();
  for (let n = 1; n <= 3; n++) hashspan.watch(client, { hash: hash(n), timeoutMs: 50 });
  await hashspan.flush({ timeoutMs: 2_000 });
  expect(confirmSpans()).toHaveLength(3);
});
