import { createWalletClient, encodeFunctionData, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const payroll = parseAbi(['function pay((address to, uint256 amount) order)']);

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** An order whose toJSON() and extra getter would change the amount if anything called them. */
function trappedOrder(): { to: `0x${string}`; amount: bigint } {
  const order = { to: TO as `0x${string}`, amount: 5n };
  Object.defineProperty(order, 'toJSON', {
    enumerable: false,
    value: () => {
      order.amount = 999n;
      return 'mutated';
    },
  });
  Object.defineProperty(order, 'audit', {
    enumerable: true,
    get: () => {
      order.amount = 777n;
      return 'audited';
    },
  });
  return order;
}

it('recording arguments leaves the argument and the sent calldata unchanged', async () => {
  const { transport, requests } = mockTransport();
  const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
    withHashspan({ recordFunctionArguments: true }),
  );
  const order = trappedOrder();

  await wallet.writeContract({ address: TO, abi: payroll, functionName: 'pay', args: [order] });

  const expected = encodeFunctionData({
    abi: payroll,
    functionName: 'pay',
    args: [{ to: TO, amount: 5n }],
  });
  const sent = requests.find((r) => r.method === 'eth_sendTransaction')?.params as [
    { data: string },
  ];
  expect(sent[0].data).toBe(expected);
  expect(order.amount).toBe(5n);
  expect(tracing.spanNamed('send 8453').attributes['blockchain.contract.function.arguments']).toBe(
    `[{"to":"${TO}","amount":"5"}]`,
  );
});
