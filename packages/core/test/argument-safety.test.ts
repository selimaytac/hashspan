import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'ab'.repeat(32)}`;
const ADDRESS = '0x2222222222222222222222222222222222222222';
const BARE = ADDRESS.slice(2);
/** The address left-padded to a 32-byte word, as in a bytes32 argument. */
const PADDED = `0x${'00'.repeat(12)}${BARE}`;
/** ABI-encoded `bytes` value whose payload is `abi.encode(address, uint256)`. */
const ENCODED = `0x${'00'.repeat(31)}20${'00'.repeat(31)}40${'00'.repeat(12)}${BARE}${'00'.repeat(31)}05`;
const ARGS = 'blockchain.contract.function.arguments';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const record = (
  options: Parameters<typeof createTxTracker>[0],
  functionArguments: readonly unknown[],
): string | undefined => {
  tracing.exporter.reset();
  createTxTracker({ recordFunctionArguments: true, ...options })
    .startSend({ chainId: CHAIN_ID, functionArguments })
    .end({ hash: HASH });
  return tracing.spanNamed(`send ${CHAIN_ID}`).attributes[ARGS] as string | undefined;
};

describe('argument serialization has no side effects', () => {
  it('never calls toJSON() or getters, and leaves the argument unchanged', () => {
    const order = { to: ADDRESS, amount: 5n } as Record<string, unknown>;
    const toJSON = vi.fn(() => {
      order.amount = 999n;
      return 'mutated';
    });
    const getter = vi.fn(() => {
      order.amount = 777n;
      return 'from getter';
    });
    order.toJSON = toJSON;
    Object.defineProperty(order, 'extra', { get: getter, enumerable: true });

    expect(record({}, [order])).toBe(`[{"to":"${ADDRESS}","amount":"5"}]`);
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(order.amount).toBe(5n);
  });

  it('skips functions, symbols and non-enumerable properties, like JSON', () => {
    const value = { a: 1, f: () => 1, [Symbol('s')]: 2 } as Record<string | symbol, unknown>;
    Object.defineProperty(value, 'hidden', { value: 3, enumerable: false });
    expect(record({}, [value, () => 1, Symbol('t'), undefined])).toBe('[{"a":1},null,null,null]');
  });

  it('stops walking at the length limit instead of serializing everything first', () => {
    let reads = 0;
    const items = Array.from({ length: 100_000 }, () => 'x'.repeat(100));
    // Counts element reads, however they are made.
    const isIndex = (key: string | symbol) => typeof key === 'string' && /^\d+$/.test(key);
    const counted = new Proxy(items, {
      get(target, key, receiver) {
        if (isIndex(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        if (isIndex(key)) reads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const value = record({}, [counted]);
    expect(value?.endsWith('...')).toBe(true);
    expect(reads).toBeLessThan(1_000);
  });

  it('serializes shared references that are not cycles', () => {
    const shared = { a: 1 };
    expect(record({}, [shared, shared, [shared]])).toBe('[{"a":1},{"a":1},[{"a":1}]]');
  });

  it('writes null for an array element with a getter, without calling it', () => {
    const getter = vi.fn(() => 'from getter');
    const items: unknown[] = [1, 2];
    Object.defineProperty(items, '1', { get: getter, enumerable: true });
    expect(record({}, [items])).toBe('[[1,null]]');
    expect(getter).not.toHaveBeenCalled();
  });

  it('skips arguments with cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(record({}, [cyclic])).toBeUndefined();
  });
});

describe('addresses cannot leak through longer hex values', () => {
  for (const mode of ['off', 'hashed'] as const) {
    it(`replaces bytes32 and ABI-encoded values in ${mode} mode`, () => {
      const value = record({ address: mode }, [PADDED, ENCODED, { nested: [PADDED] }]);
      expect(value).not.toContain(BARE);
      expect(value).toBe('["<hex>","<hex>",{"nested":["<hex>"]}]');
    });

    it(`keeps addresses out of revert reasons in ${mode} mode`, () => {
      tracing.exporter.reset();
      createTxTracker({ address: mode })
        .startConfirm({ chainId: CHAIN_ID, hash: HASH })
        .end({
          status: 'reverted',
          blockNumber: 1n,
          gasUsed: 21_000n,
          revertReason: `Blocked(${PADDED}, ${ENCODED})`,
        });
      const reason = tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes[
        'blockchain.tx.revert.reason'
      ];
      expect(reason).toBe('Blocked(<hex>, <hex>)');
    });
  }

  it('replaces transaction hashes in sanitized error messages in off and hashed mode only', () => {
    const message = `transaction ${HASH} failed for ${PADDED}`;
    const recorded = (address: 'raw' | 'off' | 'hashed') => {
      tracing.exporter.reset();
      createTxTracker({ address, errorMessages: 'sanitized' })
        .startSend({ chainId: CHAIN_ID })
        .fail(new Error(message));
      return tracing.spanNamed(`send ${CHAIN_ID}`).events[0]?.attributes?.['exception.message'];
    };
    expect(recorded('off')).toBe('transaction <hex> failed for <hex>');
    expect(recorded('hashed')).toBe('transaction <hex> failed for <hex>');
    expect(recorded('raw')).toBe(message);
  });

  it('treats a 0X prefix like 0x', () => {
    expect(record({ address: 'off' }, [PADDED.replace('0x', '0X')])).toBe('["<hex>"]');
  });

  it('keeps hex values unchanged in raw mode', () => {
    expect(record({ address: 'raw' }, [PADDED, ENCODED])).toBe(`["${PADDED}","${ENCODED}"]`);
  });
});
