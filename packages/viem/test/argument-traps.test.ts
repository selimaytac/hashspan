import { createWalletClient, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const abi = parseAbi(['function pay(uint256 amount)']);
const receipt = { status: 'success' };
const failure = new Error('base action failed');

/** Arguments that throw when telemetry reads them; the base action never reads them. */
const traps = {
  'a throwing getOwnPropertyDescriptor trap': () =>
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    ),
  'a throwing ownKeys trap': () =>
    new Proxy(
      { abi: [] },
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    ),
};

/** A revoked Proxy: reading anything from it throws. */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/**
 * A wallet whose base actions are counting stand-ins, extended with hashspan; each stand-in resolves with a fixed
 * result, or rejects when `fail` is set.
 */
function walletWithStandIns(fail = false) {
  const calls: Record<string, unknown[]> = {
    sendTransaction: [],
    writeContract: [],
    sendTransactionSync: [],
    writeContractSync: [],
    waitForTransactionReceipt: [],
    sendUserOperation: [],
    waitForUserOperationReceipt: [],
  };
  const standIn = (name: string, result: unknown) => async (args: unknown) => {
    calls[name]?.push(args);
    if (fail) throw failure;
    return result;
  };
  const wallet = createWalletClient({
    account: FROM,
    chain: base,
    transport: mockTransport().transport,
  })
    // Typed as adding nothing: the stand-ins replace viem's actions at runtime only.
    .extend((() => ({
      sendTransaction: standIn('sendTransaction', HASH),
      writeContract: standIn('writeContract', HASH),
      sendTransactionSync: standIn('sendTransactionSync', receipt),
      writeContractSync: standIn('writeContractSync', receipt),
      waitForTransactionReceipt: standIn('waitForTransactionReceipt', receipt),
      sendUserOperation: standIn('sendUserOperation', HASH),
      waitForUserOperationReceipt: standIn('waitForUserOperationReceipt', receipt),
    })) as () => Record<never, never>)
    .extend(withHashspan());
  return {
    wallet: wallet as unknown as Record<string, (args: unknown) => Promise<unknown>>,
    calls,
  };
}

const cases: [action: string, args: (trap: object) => unknown, result: unknown][] = [
  ['sendTransaction', (trap) => trap, HASH],
  ['writeContract', (trap) => trap, HASH],
  ['sendTransactionSync', (trap) => trap, receipt],
  ['writeContractSync', (trap) => trap, receipt],
  ['waitForTransactionReceipt', (trap) => trap, receipt],
  ['sendUserOperation', (trap) => trap, HASH],
  ['waitForUserOperationReceipt', (trap) => trap, receipt],
  ['sendUserOperation', (trap) => ({ account: trap, calls: [trap] }), HASH],
  ['writeContract', (trap) => ({ address: TO, abi: trap, functionName: 'pay', args: [1n] }), HASH],
  [
    'writeContractSync',
    (trap) => ({ address: TO, abi: trap, functionName: 'pay', args: [1n] }),
    receipt,
  ],
];

describe.each(Object.entries({ ...traps, 'a revoked Proxy': revoked }))(
  'arguments with %s',
  (_, trap) => {
    it.each(cases)(
      '%s calls the base action once with the same arguments',
      async (action, build, result) => {
        const { wallet, calls } = walletWithStandIns();
        const args = build(trap());

        await expect(wallet[action]?.(args)).resolves.toBe(result);
        // Compared by identity: a revoked Proxy cannot be compared deeply.
        expect(calls[action]).toHaveLength(1);
        expect(calls[action]?.[0]).toBe(args);
      },
    );

    it.each(cases)('%s passes the base action error on unchanged', async (action, build) => {
      const { wallet, calls } = walletWithStandIns(true);

      await expect(wallet[action]?.(build(trap()))).rejects.toBe(failure);
      expect(calls[action]).toHaveLength(1);
    });
  },
);

it('an ABI whose items throw still sends the call once, untraced', async () => {
  const { wallet, calls } = walletWithStandIns();
  const args = { address: TO, abi: [revoked()], functionName: 'pay', args: [1n] };

  await expect(wallet.writeContract?.(args)).resolves.toBe(HASH);
  expect(calls.writeContract).toEqual([args]);
});

it('ordinary arguments are still traced', async () => {
  const { wallet } = walletWithStandIns();
  await wallet.writeContract?.({ address: TO, abi, functionName: 'pay', args: [1n] });
  expect(tracing.spanNamed('send 8453').attributes['blockchain.contract.function.name']).toBe(
    'pay',
  );
});
