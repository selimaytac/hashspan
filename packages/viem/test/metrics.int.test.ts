import type { Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Anvil's first test account, which Anvil signs for.
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = '0x00000000000000000000000000000000000000cc';

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
beforeAll(async () => {});
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

/** A meter provider that keeps what each histogram records. */
function recordingMeterProvider() {
  const recorded = new Map<string, { value: number; attributes: Attributes }[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return {
          record: (value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push({ value, attributes });
          },
        };
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

it('records the send, confirmation and fee of a mined transaction', async () => {
  const meters = recordingMeterProvider();
  const hashspan = withHashspan({ meterProvider: meters.provider });
  const wallet = createWalletClient({
    account: ACCOUNT,
    chain: anvil,
    transport: http(RPC_URL),
  }).extend(hashspan);
  const reader = createPublicClient({
    chain: anvil,
    transport: http(RPC_URL),
    pollingInterval: 50,
  }).extend(hashspan);

  const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
  await reader.waitForTransactionReceipt({ hash });
  await hashspan.flush();

  const chain = {
    'blockchain.system': 'evm',
    'blockchain.system.name': 'evm',
    'blockchain.chain.id': 31337,
  };
  const [send] = meters.recorded('blockchain.client.send.duration');
  expect(send?.attributes).toEqual(chain);
  expect(send?.value).toBeGreaterThanOrEqual(0);
  const [confirmation] = meters.recorded('blockchain.client.confirmation.duration');
  expect(confirmation?.attributes).toEqual({ ...chain, 'blockchain.tx.status': 'success' });
  expect(confirmation?.value).toBeGreaterThanOrEqual(0);
  // The fee sample is the confirm span's fee, from the receipt.
  const fee = tracing.spanNamed('confirm 31337').attributes['blockchain.tx.fee'];
  expect(meters.recorded('blockchain.client.fee')).toEqual([
    { value: Number(fee), attributes: { ...chain, 'blockchain.tx.status': 'success' } },
  ]);
  expect(Number(fee)).toBeGreaterThan(0);
});
