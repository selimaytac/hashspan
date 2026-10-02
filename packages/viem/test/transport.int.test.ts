import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import { createPublicClient, createWalletClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { traceTransport, withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18571;
const RPC_URL = `http://127.0.0.1:${PORT}`;
// Anvil's first test account, which Anvil signs for.
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = '0x00000000000000000000000000000000000000cc';

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});
beforeAll(async () => {
  await instance.start();
});
afterAll(async () => {
  await instance.stop();
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

it('records the JSON-RPC requests of a transaction under its send span', async () => {
  const hashspan = withHashspan();
  const transport = traceTransport(http(RPC_URL));
  const wallet = createWalletClient({ account: ACCOUNT, chain: anvil, transport }).extend(hashspan);
  const reader = createPublicClient({ chain: anvil, transport, pollingInterval: 50 }).extend(
    hashspan,
  );

  const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
  await reader.waitForTransactionReceipt({ hash });
  await hashspan.flush();

  const send = tracing.spanNamed('send 31337');
  const sent = tracing.spanNamed('eth_sendTransaction');
  expect(sent.parentSpanContext?.spanId).toBe(send.spanContext().spanId);
  expect(sent.attributes).toMatchObject({
    'rpc.system.name': 'jsonrpc',
    'rpc.method': 'eth_sendTransaction',
    'server.address': '127.0.0.1',
    'server.port': PORT,
    'blockchain.chain.id': 31337,
  });
  const receipts = tracing.spans().filter((s) => s.name === 'eth_getTransactionReceipt');
  expect(receipts.length).toBeGreaterThan(0);
  // Every request ended, and none failed.
  expect(
    tracing
      .spans()
      .filter(
        (s) =>
          s.attributes['rpc.system.name'] === 'jsonrpc' && s.status.code === SpanStatusCode.ERROR,
      ),
  ).toEqual([]);
});
