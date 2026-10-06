// `blockchain.tx.wait.confirmations` on Anvil (#414). The adapter records 1 for a wait without a count, or with 0, a
// negative number or NaN, because viem then waits for one block: the first describe pins that viem behaviour, with
// blocks mined by hand, so a change of viem's default fails here instead of mislabelling spans. The absence on sync
// actions, user operations and call batches is checked in their own Anvil tests.
import { type Address, createPublicClient, createWalletClient, type Hex, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const ATTRIBUTE = 'blockchain.tx.wait.confirmations';
/** Polls of a waiting client between two checks: long enough that a wait that could resolve has. */
const SETTLE_MS = 400;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

/** Untraced client for chain control and checks, without viem's block number cache. */
const control = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
  cacheTime: 0,
  pollingInterval: 50,
});
const rpc = (method: string, params: unknown[] = []): Promise<unknown> =>
  control.request({ method: method as never, params: params as never });
const mine = (blocks = 1): Promise<unknown> => rpc('anvil_mine', [`0x${blocks.toString(16)}`]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await rpc('evm_setAutomine', [true]);
  await tracing.teardown();
});

const recorded = (): unknown[] =>
  tracing
    .spans()
    .filter((s) => s.name === 'confirm 31337')
    .map((s) => s.attributes[ATTRIBUTE]);

/** Sends a transfer untraced and returns its hash once it is mined; automine stays as it is. */
async function sent(): Promise<Hex> {
  const hash = await createWalletClient({
    account,
    chain: anvil,
    transport: http(RPC_URL),
  }).sendTransaction({ to: RECIPIENT, value: 1n });
  await control.waitForTransactionReceipt({ hash });
  return hash;
}

/** A public client extended with `hashspan`, polling often and without a block number cache. */
const reader = (hashspan: ReturnType<typeof withHashspan>) =>
  createPublicClient({
    chain: anvil,
    transport: http(RPC_URL),
    cacheTime: 0,
    pollingInterval: 50,
  }).extend(hashspan);

describe("viem's wait, as the attribute describes it", () => {
  it.each([
    ['no count', {}, 1],
    ['0', { confirmations: 0 }, 1],
    ['-1', { confirmations: -1 }, 1],
    ['NaN', { confirmations: Number.NaN }, 1],
    ['3', { confirmations: 3 }, 3],
  ])(
    'with %s resolves at the depth it records',
    async (_name, options, depth) => {
      const hash = await sent();
      // From here on, only this test mines blocks: the receipt's block is the head (depth 1).
      await rpc('evm_setAutomine', [false]);
      const hashspan = withHashspan();
      let resolved = false;
      const wait = reader(hashspan)
        .waitForTransactionReceipt({ hash, ...options })
        .then((receipt) => {
          resolved = true;
          return receipt;
        });
      for (let reached = 1; reached < depth; reached++) {
        await sleep(SETTLE_MS);
        expect(resolved, `resolved at depth ${reached}`).toBe(false);
        await mine();
      }
      const receipt = await wait;
      expect(receipt.transactionHash).toBe(hash);
      expect(Number((await control.getBlockNumber()) - receipt.blockNumber) + 1).toBe(depth);
      await hashspan.flush();
      expect(recorded()).toEqual([depth]);
    },
    15_000,
  );
});

describe('blockchain.tx.wait.confirmations on Anvil', () => {
  it('records 1 for background confirmation, also when the caller waits for 3', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);
    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    const caller = reader(hashspan).waitForTransactionReceipt({ hash, confirmations: 3 });
    // The background wait gets the first receipt; the caller's resolves two blocks later.
    await sleep(SETTLE_MS);
    await mine(2);
    await caller;
    await hashspan.flush();
    expect(recorded()).toEqual([1]);
  });

  it('records 1 for watch()', async () => {
    const hashspan = withHashspan();
    const hash = await sent();
    hashspan.watch(control, { hash });
    await hashspan.flush();
    expect(recorded()).toEqual([1]);
  });
});
