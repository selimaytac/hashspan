import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT,
  createTxTracker,
  type TxTrackerOptions,
} from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

// EIP-7702 (type 4) transactions delegate an account to contract code. The send span records how many authorizations
// the transaction carries and, for each one that is well formed, the delegated address (per the address mode) and its
// chain id, where 0 means it is valid on every chain. Signatures and nonces are never recorded.

const CHAIN_ID = 84532;
const TX_HASH = `0x${'c3'.repeat(32)}`;
const DELEGATE = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const sent = (authorizations: unknown, options: TxTrackerOptions = {}) => {
  createTxTracker(options)
    .startSend({ chainId: CHAIN_ID, authorizations } as Parameters<
      ReturnType<typeof createTxTracker>['startSend']
    >[0])
    .end({ hash: TX_HASH });
  return tracing.spanNamed(`send ${CHAIN_ID}`).attributes;
};

describe('EIP-7702 authorizations on the send span', () => {
  it('records the count, the delegated addresses and their chain ids', () => {
    const attributes = sent([
      { address: DELEGATE, chainId: CHAIN_ID },
      { address: OTHER, chainId: 0 },
    ]);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT]).toBe(2);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES]).toEqual([
      DELEGATE.toLowerCase(),
      OTHER.toLowerCase(),
    ]);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS]).toEqual([CHAIN_ID, 0]);
  });

  it('never records signatures or nonces', () => {
    const attributes = sent([
      {
        address: DELEGATE,
        chainId: CHAIN_ID,
        nonce: 7,
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
        yParity: 1,
      },
    ]);
    const recorded = JSON.stringify(attributes);
    expect(recorded).not.toContain('11'.repeat(32));
    expect(recorded).not.toContain('22'.repeat(32));
    expect(Object.keys(attributes).filter((key) => key.includes('authorization'))).toEqual([
      ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT,
      ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES,
      ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS,
    ]);
  });

  it('follows the address mode for the delegated addresses', () => {
    const hashed = sent([{ address: DELEGATE, chainId: CHAIN_ID }], { address: 'hashed' });
    const [address] = hashed[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES] as string[];
    expect(address).toMatch(/^sha256:/);
    expect(hashed[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS]).toEqual([CHAIN_ID]);
  });

  it('records no addresses in off mode, but still the count and chain ids', async () => {
    const off = sent([{ address: DELEGATE, chainId: 0 }], { address: 'off' });
    expect(off[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES]).toBeUndefined();
    expect(off[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT]).toBe(1);
    expect(off[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS]).toEqual([0]);
  });

  it('counts every authorization but lists only well-formed ones, keeping addresses and chain ids aligned', () => {
    const attributes = sent([
      { address: DELEGATE, chainId: CHAIN_ID },
      { address: 'not an address', chainId: 1 },
      { address: OTHER, chainId: -1 },
      { address: OTHER, chainId: 1.5 },
      null,
      'text',
      { address: OTHER, chainId: 10 },
    ]);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT]).toBe(7);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES]).toEqual([
      DELEGATE.toLowerCase(),
      OTHER.toLowerCase(),
    ]);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS]).toEqual([CHAIN_ID, 10]);
  });

  it('lists at most 64 authorizations', () => {
    const many = Array.from({ length: 100 }, () => ({ address: DELEGATE, chainId: CHAIN_ID }));
    const attributes = sent(many);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT]).toBe(100);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES]).toHaveLength(64);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS]).toHaveLength(64);
  });

  it('records nothing for a missing, empty or non-array list', () => {
    for (const authorizations of [undefined, [], 'text', { length: 2 }]) {
      tracing.exporter.reset();
      const attributes = sent(authorizations);
      expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT]).toBeUndefined();
      expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES]).toBeUndefined();
      expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS]).toBeUndefined();
    }
  });

  it('reads only own data properties, so no getter of the caller runs', () => {
    let read = false;
    const entry = Object.defineProperty({ chainId: CHAIN_ID }, 'address', {
      enumerable: true,
      get: () => {
        read = true;
        return DELEGATE;
      },
    });
    const attributes = sent([entry]);
    expect(read).toBe(false);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT]).toBe(1);
    expect(attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES]).toBeUndefined();
  });
});
