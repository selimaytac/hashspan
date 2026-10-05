import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

// waitForTransactionReceipt gets its arguments shadowed (to capture a replacement) only when they are a plain object:
// the getters of a class instance would run with the shadow as `this`, where its private fields are missing.

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

class WaitArgs {
  readonly hash = HASH;
  #timeout = 5_000;
  get timeout(): number {
    return this.#timeout;
  }
}

const reader = (traced: boolean) => {
  const hashspan = withHashspan();
  const client = createPublicClient({
    chain: base,
    transport: mockTransport().transport,
    pollingInterval: 10,
  });
  return { client: traced ? client.extend(hashspan) : client, hashspan };
};

describe('waitForTransactionReceipt with a class instance as its arguments', () => {
  it('has the outcome of the untraced call, and is traced', async () => {
    const untraced = await reader(false).client.waitForTransactionReceipt(new WaitArgs() as never);
    const { client, hashspan } = reader(true);
    const traced = await client.waitForTransactionReceipt(new WaitArgs() as never);
    expect(traced).toEqual(untraced);
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBe('success');
  });
});
