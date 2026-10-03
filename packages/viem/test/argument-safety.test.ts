import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
} from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

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

describe('wait options the adapter forwards', () => {
  /** Runs one wait untraced and traced; both must succeed and call onReplaced the same number of times. */
  const sameAsUntraced = async (
    options: (onReplaced: () => void) => object,
    { spreadFirst = false }: { spreadFirst?: boolean } = {},
  ) => {
    const run = async (traced: boolean) => {
      // The receipt is that of another transaction: viem reports a replacement.
      const mock = mockTransport({
        advanceBlocks: true,
        blockIncludesTransaction: true,
        mined: (() => {
          let calls = 0;
          // From viem 2.33.0, a wait asks for the receipt once before it starts polling: one request more.
          const misses = viemAtLeast('2.33.0') ? 2 : 1;
          return () => ++calls > misses;
        })(),
      });
      const plain = createPublicClient({
        chain: base,
        transport: mock.transport,
        pollingInterval: 10,
      });
      // An extension applied before hashspan that copies the wait options, as wrappers often do.
      const spreading = spreadFirst
        ? plain.extend((client) => {
            const wait = client.waitForTransactionReceipt;
            return {
              waitForTransactionReceipt: (args: Parameters<typeof wait>[0]) => wait({ ...args }),
            };
          })
        : plain;
      const reader = traced ? spreading.extend(withHashspan()) : spreading;
      let replaced = 0;
      // Passed as built: a copy would lose the freezing or the prototype under test.
      const receipt = await reader.waitForTransactionReceipt(options(() => replaced++) as never);
      return { status: receipt.status, replaced };
    };
    const plain = await run(false);
    expect(plain.replaced).toBe(1);
    expect(await run(true)).toEqual(plain);
  };

  it('keep an onReplaced callback of frozen options', async () => {
    await sameAsUntraced((onReplaced) => Object.freeze({ hash: HASH, onReplaced, retryDelay: 1 }));
  });

  it('keep every option when an extension applied before hashspan spreads them', async () => {
    await sameAsUntraced((onReplaced) => ({ hash: HASH, onReplaced, retryDelay: 1 }), {
      spreadFirst: true,
    });
  });

  it('keep an onReplaced callback inherited from a prototype', async () => {
    await sameAsUntraced((onReplaced) =>
      Object.assign(Object.create({ onReplaced }), { hash: HASH, retryDelay: 1 }),
    );
  });
});

it('runs no getter inside the ABI: writeContract sends the same as without tracing', async () => {
  const run = async (traced: boolean) => {
    const mock = mockTransport();
    const client = createWalletClient({ account: FROM, chain: base, transport: mock.transport });
    const wallet = traced ? client.extend(withHashspan()) : client;
    let reads = 0;
    // An ABI built at runtime whose `inputs` getter changes on every read.
    const pay = {
      type: 'function',
      name: 'pay',
      stateMutability: 'nonpayable',
      outputs: [],
      get inputs() {
        reads++;
        return [{ name: 'amount', type: reads % 2 === 1 ? 'uint256' : 'uint8' }];
      },
    };
    await wallet.writeContract({
      address: TO,
      abi: [pay] as never,
      functionName: 'pay',
      args: [2n] as never,
    });
    const sent = mock.requests.find((r) => r.method === 'eth_sendTransaction')?.params;
    return { reads, data: (sent as [{ data: string }] | undefined)?.[0].data };
  };
  const plain = await run(false);
  expect(await run(true)).toEqual(plain);
});

it('records the selector of overloads and nested tuples from its copy of the ABI', async () => {
  const abi = parseAbi([
    'struct Leg { address to; uint256 amount; }',
    'struct Meta { address payer; uint64 nonce; }',
    'struct Header { uint8 kind; Meta meta; }',
    'struct Batch { Leg[] legs; Header header; }',
    'function settle(Batch batch)',
    'function settle(Batch batch, uint256 deadline)',
  ]);
  const batch = {
    legs: [{ to: TO, amount: 1n }],
    header: { kind: 1, meta: { payer: FROM, nonce: 7n } },
  };
  const wallet = createWalletClient({
    account: FROM,
    chain: base,
    transport: mockTransport().transport,
  }).extend(withHashspan());
  await wallet.writeContract({ address: TO, abi, functionName: 'settle', args: [batch, 9n] });
  const [, withDeadline] = abi.filter((item) => item.type === 'function');
  expect(tracing.spanNamed('send 8453').attributes['blockchain.contract.function.selector']).toBe(
    toFunctionSelector(withDeadline as never),
  );
});
