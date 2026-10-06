// The order of `withHashspan()` and the Tempo extension of viem (`tempoActions()` of `viem/tempo`, viem 2.43.0): its
// actions call viem's action functions with the client they extend, so they reach the traced actions only when
// `withHashspan()` was applied before it (#402). Either way, the call's result and requests stay those of viem.
import { createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** A TIP-20 token on Tempo. */
const TOKEN = '0x20c0000000000000000000000000000000000001';

// `viem/tempo` came with viem 2.43.0: imported only on a viem that has it, so the floor of the peer range still loads.
describe.skipIf(!viemAtLeast('2.43.0'))('the Tempo extension and withHashspan()', () => {
  /** Runs `token.transfer` on a client extended in `order`, and returns its result and the requests it made. */
  async function transfer(order: 'plain' | 'hashspan first' | 'tempo first') {
    const { tempoActions } = await import('viem/tempo');
    const hashspan = withHashspan();
    const mock = mockTransport({ chainIdHex: `0x${base.id.toString(16)}`, retryCount: 0 });
    const client = createWalletClient({ account: FROM, chain: base, transport: mock.transport });
    const extended =
      order === 'plain'
        ? client.extend(tempoActions())
        : order === 'hashspan first'
          ? client.extend(hashspan).extend(tempoActions())
          : client.extend(tempoActions()).extend(hashspan);
    const result = await extended.token.transfer({ token: TOKEN, to: TO, amount: 1n } as never);
    await hashspan.flush();
    return { result, requests: mock.requests };
  }

  const sends = () => tracing.spans().filter((s) => s.name === `send ${base.id}`);

  it('traces its actions when withHashspan() was applied before it, as a sendTransaction to the token', async () => {
    const plain = await transfer('plain');
    const traced = await transfer('hashspan first');

    expect(traced.result).toEqual(plain.result);
    expect(traced.result).toBe(HASH);
    expect(traced.requests).toEqual(plain.requests);
    const [send, ...more] = sends();
    expect(more).toEqual([]);
    expect(send?.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': FROM,
      'blockchain.tx.to': TOKEN,
      // TIP-20 `transfer(address,uint256)`.
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
  });

  it('does not trace them when withHashspan() was applied after it', async () => {
    const plain = await transfer('plain');
    const untraced = await transfer('tempo first');

    expect(untraced.result).toEqual(plain.result);
    expect(untraced.requests).toEqual(plain.requests);
    expect(sends()).toEqual([]);
  });
});
