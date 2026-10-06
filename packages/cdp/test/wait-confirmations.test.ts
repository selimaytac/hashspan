// `blockchain.tx.wait.confirmations` (#414) on the confirm span of a network-scoped `waitForTransactionReceipt`: the
// SDK passes the options to viem unchanged, so the count is recorded as viem applies it; the `{ transactionHash }`
// form calls viem with the hash alone (1). With a reader, the background confirmation records 1.
import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingGetters } from '../../core/test/hostile.js';
import { mockTransport } from '../../viem/test/mock-transport.js';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const HASH = `0x${'ab'.repeat(32)}` as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const RECEIPT = {
  transactionHash: HASH,
  status: 'success',
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

type Wait = (options: unknown) => Promise<unknown>;

/** A CDP client whose network-scoped accounts wait like the SDK's: through viem, here a stand-in returning a receipt. */
function fakeCdp() {
  class EvmClient {
    async createAccount() {
      const account = {
        address: ACCOUNT,
        sendTransaction: async (_options: unknown) => ({ transactionHash: HASH }),
        async useNetwork(network: string) {
          return {
            address: ACCOUNT,
            network,
            // On Base the SDK sends through the account's own method.
            sendTransaction: (options: object) => account.sendTransaction({ ...options, network }),
            waitForTransactionReceipt: async () => RECEIPT,
          };
        },
      };
      return account;
    }
  }
  return { evm: new EvmClient() };
}

async function scoped(options: object = {}) {
  const cdp = fakeCdp();
  const hashspan = withHashspan(cdp, options);
  const account = await cdp.evm.createAccount();
  const network = (await account.useNetwork('base')) as unknown as {
    sendTransaction: Wait;
    waitForTransactionReceipt: Wait;
  };
  return {
    hashspan,
    send: network.sendTransaction.bind(network),
    wait: network.waitForTransactionReceipt.bind(network),
  };
}

const recorded = (): unknown[] =>
  tracing
    .spans()
    .filter((s) => s.name === 'confirm 8453')
    .map((s) => s.attributes['blockchain.tx.wait.confirmations']);

describe('blockchain.tx.wait.confirmations of a network-scoped waitForTransactionReceipt', () => {
  it.each([
    ['3', { confirmations: 3 }, 3],
    ['no count', {}, 1],
    ['0', { confirmations: 0 }, 1],
    ['-1', { confirmations: -1 }, 1],
    ['NaN', { confirmations: Number.NaN }, 1],
    ['1.5', { confirmations: 1.5 }, undefined],
    ['2**53 + 1', { confirmations: 2 ** 53 + 1 }, undefined],
    ['3n', { confirmations: 3n }, undefined],
  ])('records %s as viem applies it', async (_name, options, expected) => {
    const { hashspan, wait } = await scoped();
    await wait({ hash: HASH, ...options });
    await hashspan.flush();
    expect(recorded()).toEqual([expected]);
  });

  it('records 1 for the transactionHash form, which the SDK passes on without a count', async () => {
    const { hashspan, wait } = await scoped();
    await wait({ transactionHash: HASH, confirmations: 5 });
    await hashspan.flush();
    expect(recorded()).toEqual([1]);
  });

  it('runs no getter of the count and records nothing for it', async () => {
    const { hashspan, wait } = await scoped();
    const options = countingGetters({ confirmations: 3 });
    Object.defineProperty(options.value, 'hash', { value: HASH, enumerable: true });
    await wait(options.value);
    await hashspan.flush();
    expect(options.reads()).toBe(0);
    expect(recorded()).toEqual([undefined]);
  });

  it('records nothing for an inherited count', async () => {
    const { hashspan, wait } = await scoped();
    await wait(Object.assign(Object.create({ confirmations: 3 }), { hash: HASH }));
    await hashspan.flush();
    expect(recorded()).toEqual([undefined]);
  });

  it('records 1 with a reader, from the background confirmation', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport().transport,
      pollingInterval: 10,
    });
    const { hashspan, send, wait } = await scoped({ reader });
    await send({ transaction: { to: ACCOUNT } });
    // The caller's wait is passed on untraced: the background confirmation of the send records the receipt.
    await wait({ hash: HASH, confirmations: 3 });
    await hashspan.flush();
    expect(recorded()).toEqual([1]);
  });
});
