import { parseAbi, toFunctionSelector } from 'viem';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { abiForTelemetry } from '../src/arguments.js';
import { withHashspan } from '../src/index.js';
import { HASH, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

// writeContract reads the call's arguments only to tell overloads apart, and its copies of the arguments and the
// ABI are bounded, so telemetry adds no unbounded work before the call (ADR 0025).

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** `value` behind a Proxy that counts the own properties read from it, as telemetry reads them. */
function counted<T extends object>(value: T): { value: T; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(value, {
    getOwnPropertyDescriptor(target, key) {
      reads++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { value: proxy, reads: () => reads };
}

/** writeContract of a client on Base whose base action notes how many reads telemetry made before it ran. */
function client(readsSoFar: () => number) {
  let readsAtCall = -1;
  const actions = withHashspan()({
    chain: { id: 8453 },
    request: async () => '0x2105',
    writeContract: async () => {
      readsAtCall = readsSoFar();
      return HASH;
    },
  } as never) as { writeContract: (args: unknown) => Promise<string> };
  return { writeContract: actions.writeContract, readsAtCall: () => readsAtCall };
}

const selector = () =>
  tracing.spanNamed('send 8453').attributes['blockchain.contract.function.selector'];

it('reads no argument of a function without overloads', async () => {
  const abi = parseAbi(['function pay(uint256[] amounts)']);
  const args = counted([new Array(10_000).fill(1n)]);
  const { writeContract, readsAtCall } = client(args.reads);
  await writeContract({ address: TO, abi, functionName: 'pay', args: args.value });
  expect(readsAtCall()).toBe(0);
  expect(selector()).toBe(toFunctionSelector(abi[0]));
});

it('stops copying the arguments of an overload at its bound, and records no selector', async () => {
  const abi = parseAbi([
    'function pay(uint256[] amounts)',
    'function pay(uint256[] amounts, uint256 deadline)',
  ]);
  const amounts = counted(new Array(1_000_000).fill(1n));
  const { writeContract, readsAtCall } = client(amounts.reads);
  expect(
    await writeContract({ address: TO, abi, functionName: 'pay', args: [amounts.value] }),
  ).toBe(HASH);
  expect(readsAtCall()).toBe(1); // the length only
  expect(selector()).toBeUndefined();
  expect(tracing.spanNamed('send 8453').attributes['blockchain.contract.function.name']).toBe(
    'pay',
  );
});

it('still tells overloads apart within the bound', async () => {
  const abi = parseAbi([
    'function pay(uint256[] amounts)',
    'function pay(uint256[] amounts, uint256 deadline)',
  ]);
  const { writeContract } = client(() => 0);
  await writeContract({ address: TO, abi, functionName: 'pay', args: [[1n, 2n], 3n] });
  expect(selector()).toBe(toFunctionSelector(abi[1]));
});

it('reads only the length of an ABI longer than its bound', async () => {
  const abi = counted(new Array(1_000_000));
  const { writeContract, readsAtCall } = client(abi.reads);
  expect(await writeContract({ address: TO, abi: abi.value, functionName: 'pay', args: [] })).toBe(
    HASH,
  );
  expect(readsAtCall()).toBe(1);
  expect(selector()).toBeUndefined();
});

it('copies an ABI once per function name, so transactions to one contract share the copy', () => {
  const abi = parseAbi([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
    'error Unauthorized(address caller)',
  ]);
  const first = abiForTelemetry(abi, 'transfer');
  expect(first).toHaveLength(2);
  expect(abiForTelemetry(abi, 'transfer')).toBe(first);
  expect(abiForTelemetry(abi, 'approve')).not.toBe(first);
  expect(abiForTelemetry([...abi], 'transfer')).not.toBe(first);
});
