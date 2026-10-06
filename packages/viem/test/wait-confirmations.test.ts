// `blockchain.tx.wait.confirmations` (#414): the confirmations a wait asked for, as viem applies them, read from own
// data properties only (ADR 0025). Which wait of a shared confirm span records it is tested in the core
// (packages/core/test/wait-confirmations.test.ts); viem's default is pinned on Anvil (wait-confirmations.int.test.ts).
import { createTxTracker, type TxTracker } from '@hashspan/core';
import { createPublicClient, createWalletClient, publicActions } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingGetters } from '../../core/test/hostile.js';
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

const ATTRIBUTE = 'blockchain.tx.wait.confirmations';
/** Long enough for a wait of a few confirmations on the mock, whose block number advances on every poll. */
const WAIT_MS = 300;

const recorded = (): unknown[] =>
  tracing
    .spans()
    .filter((s) => s.name === 'confirm 8453')
    .map((s) => s.attributes[ATTRIBUTE]);

function reader(hashspan = withHashspan(), chain: typeof base | undefined = base) {
  const { transport } = mockTransport({ advanceBlocks: true });
  const client = createPublicClient({ chain, transport, pollingInterval: 10 });
  return { client: client.extend(hashspan), plain: client, hashspan };
}

/** Waits with `args` (the hash and a timeout are added), whatever the wait's outcome, and flushes. */
async function waitWith(args: object, chain: typeof base | undefined = base): Promise<unknown[]> {
  const { client, hashspan } = reader(withHashspan(), chain);
  await client
    .waitForTransactionReceipt(Object.assign(args, { hash: HASH, timeout: WAIT_MS }) as never)
    .catch(() => {});
  await hashspan.flush();
  return recorded();
}

describe('blockchain.tx.wait.confirmations of waitForTransactionReceipt', () => {
  it('records the count given', async () => {
    expect(await waitWith({ confirmations: 3 })).toEqual([3]);
  });

  it('records 1 for a wait without a count', async () => {
    expect(await waitWith({})).toEqual([1]);
  });

  it.each([
    ['undefined', undefined],
    ['0', 0],
    ['-1', -1],
    ['-1.5', -1.5],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('records 1, what viem waits for, for %s', async (_name, confirmations) => {
    expect(await waitWith({ confirmations })).toEqual([1]);
  });

  it.each([
    ['1.5', 1.5],
    ['2**53 + 1', 2 ** 53 + 1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['3n', 3n],
    ['"3"', '3'],
    ['null', null],
  ])('records nothing for %s', async (_name, confirmations) => {
    expect(await waitWith({ confirmations })).toEqual([undefined]);
  });

  it('records nothing for an inherited count, which it never reads', async () => {
    expect(await waitWith(Object.create({ confirmations: 2 }))).toEqual([undefined]);
  });

  it('runs no getter of the count and records nothing for it', async () => {
    const read = async (traced: boolean): Promise<number> => {
      const args = countingGetters({ confirmations: 2 });
      Object.assign(args.value, { hash: HASH, timeout: WAIT_MS });
      const { client, plain, hashspan } = reader();
      await (traced ? client : plain)
        .waitForTransactionReceipt(args.value as never)
        .catch(() => {});
      await hashspan.flush();
      return args.reads();
    };
    // viem reads the getter itself; telemetry adds no read.
    expect(await read(true)).toBe(await read(false));
    expect(recorded()).toEqual([undefined]);
  });

  it('records the count of a wait on a client without a chain, once the chain id is known', async () => {
    expect(await waitWith({ confirmations: 2 }, undefined)).toEqual([2]);
  });

  it('records 1 for background confirmation, which ends the span before a caller wait of 3', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const { transport } = mockTransport({ advanceBlocks: true });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport,
      pollingInterval: 10,
    })
      .extend(publicActions)
      .extend(hashspan);
    const hash = await wallet.sendTransaction({ to: TO });
    await wallet.waitForTransactionReceipt({ hash, confirmations: 3 });
    await hashspan.flush();
    expect(recorded()).toEqual([1]);
  });

  it('records 1 for watch()', async () => {
    const { plain, hashspan } = reader();
    hashspan.watch(plain, { hash: HASH });
    await hashspan.flush();
    expect(recorded()).toEqual([1]);
  });

  it('records nothing with a tracker of a core that does not know the count', async () => {
    const current = createTxTracker();
    // A core before the count: it reads the fields it knows and ignores the rest (ADR 0014).
    const older: TxTracker = {
      ...current,
      startConfirm: (input, parent) =>
        current.startConfirm({ chainId: input.chainId, hash: input.hash }, parent),
    };
    const { client, hashspan } = reader(withHashspan({ tracker: older }));
    const receipt = await client.waitForTransactionReceipt({ hash: HASH, confirmations: 2 });
    await hashspan.flush();
    expect(receipt.transactionHash).toBe(HASH);
    expect(recorded()).toEqual([undefined]);
  });
});
