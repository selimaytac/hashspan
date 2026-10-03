import { createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

// The send span of an EIP-7702 transaction records its authorization list: how many, and each delegated address with
// its chain id. Signatures and nonces never reach telemetry, and no getter of the caller's runs.

const DELEGATE = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B' as const;
const R = `0x${'11'.repeat(32)}` as const;
const S = `0x${'22'.repeat(32)}` as const;

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const wallet = () =>
  createWalletClient({ account: FROM, chain: base, transport: mockTransport().transport }).extend(
    withHashspan(),
  );

it('records the authorizations of a type 4 transaction on its send span', async () => {
  await wallet().sendTransaction({
    to: TO,
    authorizationList: [
      { address: DELEGATE, chainId: base.id, nonce: 3, r: R, s: S, yParity: 1 },
      { address: TO, chainId: 0, nonce: 4, r: R, s: S, yParity: 0 },
    ],
  });

  const send = tracing.spanNamed(`send ${base.id}`);
  expect(send.attributes['blockchain.tx.authorization.count']).toBe(2);
  expect(send.attributes['blockchain.tx.authorization.addresses']).toEqual([
    DELEGATE.toLowerCase(),
    TO.toLowerCase(),
  ]);
  expect(send.attributes['blockchain.tx.authorization.chain_ids']).toEqual([base.id, 0]);
  const recorded = JSON.stringify(send.attributes);
  expect(recorded).not.toContain('11'.repeat(32));
  expect(recorded).not.toContain('22'.repeat(32));
});

it('records no authorization attributes on other transactions', async () => {
  await wallet().sendTransaction({ to: TO, value: 1n });
  const keys = Object.keys(tracing.spanNamed(`send ${base.id}`).attributes);
  expect(keys.filter((key) => key.includes('authorization'))).toEqual([]);
});

it('reads the list without running a getter of the caller', async () => {
  const counted = () => {
    const entry = { chainId: base.id, nonce: 3, r: R, s: S, yParity: 1, reads: 0 };
    Object.defineProperty(entry, 'address', {
      enumerable: true,
      get: () => {
        entry.reads++;
        return DELEGATE;
      },
    });
    return entry as typeof entry & { address: `0x${string}` };
  };
  const plain = createWalletClient({
    account: FROM,
    chain: base,
    transport: mockTransport().transport,
  });
  const untraced = counted();
  await plain.sendTransaction({ to: TO, authorizationList: [untraced] });
  const traced = counted();
  await wallet().sendTransaction({ to: TO, authorizationList: [traced] });

  // viem reads the getter to send the transaction; telemetry adds no read of its own and records no address.
  expect(traced.reads).toBe(untraced.reads);
  const send = tracing.spanNamed(`send ${base.id}`);
  expect(send.attributes['blockchain.tx.authorization.count']).toBe(1);
  expect(send.attributes['blockchain.tx.authorization.addresses']).toBeUndefined();
});

it('reads at most 64 entries of a long list, and still counts them all', async () => {
  const entry = { address: DELEGATE, chainId: base.id, nonce: 3, r: R, s: S, yParity: 1 };
  const read = new Set<string>();
  const list = new Proxy(
    Array.from({ length: 1_000 }, () => entry),
    {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) read.add(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  await wallet().sendTransaction({ to: TO, authorizationList: list });

  const send = tracing.spanNamed(`send ${base.id}`);
  expect(send.attributes['blockchain.tx.authorization.count']).toBe(1_000);
  expect(send.attributes['blockchain.tx.authorization.addresses']).toHaveLength(64);
  expect(read.size).toBe(64);
});
