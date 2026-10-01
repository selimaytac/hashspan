import { createPublicClient, createWalletClient, encodeFunctionData, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
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

/**
 * Call arguments whose `to` getter returns a different address on every read, counting the reads: telemetry must
 * not run it, so the wrapped call sends what the unwrapped call sends.
 */
function shiftingArgs() {
  let reads = 0;
  const addresses = [TO, FROM, '0x3333333333333333333333333333333333333333'] as const;
  const args = {
    value: 1n,
    get to() {
      return addresses[Math.min(reads++, addresses.length - 1)];
    },
  };
  return { args, reads: () => reads };
}

const sentTo = (requests: { method: string; params?: unknown }[]) =>
  requests
    .filter((r) => r.method === 'eth_sendTransaction')
    .map((r) => (r.params as [{ to: string }])[0].to);

it('runs no getter of sendTransaction arguments: the call sends the same as without tracing', async () => {
  const run = async (traced: boolean) => {
    const mock = mockTransport();
    const client = createWalletClient({ account: FROM, chain: base, transport: mock.transport });
    const wallet = traced ? client.extend(withHashspan()) : client;
    const { args, reads } = shiftingArgs();
    await wallet.sendTransaction(args as never);
    return { sent: sentTo(mock.requests), reads: reads() };
  };
  const plain = await run(false);
  expect(await run(true)).toEqual(plain);
  // The getter is left out of the span rather than read.
  expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.to']).toBeUndefined();
});

it('runs no getter inside writeContract arguments while matching ABI overloads', async () => {
  const overloaded = parseAbi([
    'function pay(address to)',
    'function pay(address to, uint256 amount)',
  ]);
  const run = async (traced: boolean) => {
    const mock = mockTransport();
    const client = createWalletClient({ account: FROM, chain: base, transport: mock.transport });
    const wallet = traced ? client.extend(withHashspan()) : client;
    let reads = 0;
    const args = [TO, 5n];
    Object.defineProperty(args, '1', {
      enumerable: true,
      get: () => {
        reads++;
        return 5n;
      },
    });
    await wallet.writeContract({
      address: TO,
      abi: overloaded,
      functionName: 'pay',
      args: args as unknown as readonly [`0x${string}`, bigint],
    });
    return { reads, data: mock.requests.find((r) => r.method === 'eth_sendTransaction')?.params };
  };
  const plain = await run(false);
  expect(await run(true)).toEqual(plain);
});

it('passes a wait whose hash is a getter on untouched, without tracing it', async () => {
  const mock = mockTransport();
  const reader = createPublicClient({ chain: base, transport: mock.transport }).extend(
    withHashspan(),
  );
  let reads = 0;
  const args = {
    get hash() {
      reads++;
      return HASH;
    },
  };
  await reader.waitForTransactionReceipt(args as never);
  const plainReads = reads;
  reads = 0;
  await createPublicClient({
    chain: base,
    transport: mockTransport().transport,
  }).waitForTransactionReceipt(args as never);
  expect(plainReads).toBe(reads);
  expect(tracing.spans()).toHaveLength(0);
});

it("keeps a wait's onReplaced getter working and unread by telemetry", async () => {
  const run = async (traced: boolean) => {
    const plain = createPublicClient({ chain: base, transport: mockTransport().transport });
    const reader = traced ? plain.extend(withHashspan()) : plain;
    let reads = 0;
    const args = {
      hash: HASH,
      get onReplaced() {
        reads++;
        return () => {};
      },
    };
    await reader.waitForTransactionReceipt(args as never);
    return reads;
  };
  expect(await run(true)).toBe(await run(false));
});
