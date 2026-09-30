import { createTxTracker } from '@hashspan/core';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, serializeTransaction } from 'viem';
import { base, polygon } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTransport } from '../../viem/test/mock-transport.js';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const HASH = `0x${'ab'.repeat(32)}`;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const USDC = '0x3333333333333333333333333333333333333333';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** A server account shaped like the SDK's: methods read `this.address`, and scoped accounts call back into it. */
function fakeAccount(calls: string[] = []) {
  const send = async function (this: { address: string }, _opts: unknown) {
    calls.push(`send from ${this.address}`);
    return { transactionHash: HASH };
  };
  const account: Record<string, unknown> & { address: string } = {
    address: ACCOUNT,
    sendTransaction: send,
    transfer: send,
    swap: send,
    useSpendPermission: send,
    async useNetwork(network: string) {
      return {
        address: ACCOUNT,
        network,
        // On CDP API chains the SDK calls the account's own method; elsewhere it sends through viem itself.
        sendTransaction: async (opts: object) =>
          ['base', 'base-sepolia', 'ethereum', 'ethereum-sepolia'].includes(network)
            ? (account.sendTransaction as (o: object) => Promise<unknown>)({ ...opts, network })
            : { transactionHash: HASH },
        transfer: async () => ({ transactionHash: HASH }),
      };
    },
  };
  return account;
}

function fakeCdp(calls: string[] = []) {
  class EvmClient {
    async sendTransaction(_opts: unknown) {
      return { transactionHash: HASH };
    }
    async createAccount() {
      return fakeAccount(calls);
    }
    async getAccount() {
      return fakeAccount(calls);
    }
    async getOrCreateAccount() {
      return fakeAccount(calls);
    }
    async importAccount() {
      return fakeAccount(calls);
    }
    async listAccounts() {
      return { accounts: [fakeAccount(calls), fakeAccount(calls)] };
    }
  }
  return {
    evm: new EvmClient() as unknown as Record<string, (options?: unknown) => Promise<unknown>>,
  };
}

const sends = () => tracing.spans().filter((s) => s.name.startsWith('send '));
const reader = (receipt?: Record<string, unknown> | null) =>
  createPublicClient({
    chain: base,
    transport: mockTransport(receipt === undefined ? {} : { receipt }).transport,
    pollingInterval: 10,
  });

describe('cdp.evm.sendTransaction', () => {
  it('records a send span and confirms through the reader', async () => {
    const cdp = fakeCdp();
    const hashspan = withHashspan(cdp, { reader: reader() });

    const result = await cdp.evm.sendTransaction!({
      address: ACCOUNT,
      network: 'base',
      transaction: { to: TO, value: 5n, data: '0xa9059cbb0000' },
    } as never);
    expect(result).toEqual({ transactionHash: HASH });
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': ACCOUNT,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '5',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  });

  it('parses a serialized transaction', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const transaction = serializeTransaction({
      chainId: 8453,
      to: TO,
      value: 7n,
      nonce: 3,
      type: 'eip1559',
    });
    await cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base', transaction } as never);
    expect(tracing.spanNamed('send 8453').attributes).toMatchObject({
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '7',
      'blockchain.tx.nonce': 3,
    });
  });

  it('records a failure and rethrows the original error', async () => {
    const cdp = fakeCdp();
    const failure = new Error('insufficient funds');
    (cdp.evm as unknown as { sendTransaction: () => Promise<never> }).sendTransaction =
      async () => {
        throw failure;
      };
    withHashspan(cdp);
    await expect(
      cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base', transaction: {} } as never),
    ).rejects.toBe(failure);
    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('passes calls on unknown networks through without a span', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp);
    await expect(
      cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'moonbase', transaction: {} } as never),
    ).resolves.toEqual({ transactionHash: HASH });
    expect(tracing.spans()).toHaveLength(0);
  });

  it('records only send spans without a reader, and skips a reader on another chain', async () => {
    const cdp = fakeCdp();
    const other = createPublicClient({ chain: polygon, transport: mockTransport().transport });
    const hashspan = withHashspan(cdp, { reader: other });
    await cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base', transaction: {} } as never);
    await hashspan.flush();
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('asks a reader function for the chain of the transaction', async () => {
    const cdp = fakeCdp();
    const pick = vi.fn((chainId: number) => (chainId === 8453 ? reader() : undefined));
    const hashspan = withHashspan(cdp, { reader: pick });
    await cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base', transaction: {} } as never);
    await hashspan.flush();
    expect(pick).toHaveBeenCalledWith(8453);
    expect(tracing.spanNamed('confirm 8453')).toBeDefined();
  });

  it('never changes the result when the tracker throws', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker();
    tracker.startSend = () => {
      throw new Error('boom');
    };
    const cdp = fakeCdp();
    withHashspan(cdp, { tracker });
    await expect(
      cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base', transaction: {} } as never),
    ).resolves.toEqual({ transactionHash: HASH });
  });

  it('wraps once when called twice', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    withHashspan(cdp);
    await cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base', transaction: {} } as never);
    expect(sends()).toHaveLength(1);
  });
});

describe('server accounts', () => {
  const accountOf = async (factory: string, cdp = fakeCdp()) => {
    withHashspan(cdp);
    return (await cdp.evm[factory]!()) as unknown as Record<
      string,
      (o?: unknown) => Promise<unknown>
    >;
  };

  for (const factory of ['createAccount', 'getAccount', 'getOrCreateAccount', 'importAccount']) {
    it(`traces sends of accounts from ${factory}, with the account as this`, async () => {
      const calls: string[] = [];
      const account = await accountOf(factory, fakeCdp(calls));
      await account.sendTransaction!({ network: 'base-sepolia', transaction: { to: TO } });
      expect(calls).toEqual([`send from ${ACCOUNT}`]);
      expect(tracing.spanNamed('send 84532').attributes['blockchain.tx.from']).toBe(ACCOUNT);
    });
  }

  it('wraps an account object once when a factory returns it again', async () => {
    const cdp = fakeCdp();
    const same = fakeAccount();
    cdp.evm.getAccount = async () => same;
    withHashspan(cdp);
    await cdp.evm.getAccount!();
    const account = (await cdp.evm.getAccount!()) as unknown as Record<
      string,
      (o: unknown) => Promise<unknown>
    >;
    await account.sendTransaction!({ network: 'base', transaction: {} });
    expect(sends()).toHaveLength(1);
  });

  it('traces accounts returned by listAccounts', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const { accounts } = (await cdp.evm.listAccounts!()) as unknown as {
      accounts: Record<string, (o: unknown) => Promise<unknown>>[];
    };
    for (const account of accounts)
      await account.sendTransaction!({ network: 'base', transaction: {} });
    expect(sends()).toHaveLength(2);
  });

  it('records an ETH transfer as a value transfer', async () => {
    const account = await accountOf('createAccount');
    await account.transfer!({ to: TO, amount: 9n, token: 'eth', network: 'base' });
    expect(tracing.spanNamed('send 8453').attributes).toMatchObject({
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '9',
    });
  });

  it('records a token transfer as a call to the token contract', async () => {
    const account = await accountOf('createAccount');
    await account.transfer!({ to: { address: TO }, amount: 9n, token: USDC, network: 'base' });
    const attributes = tracing.spanNamed('send 8453').attributes;
    expect(attributes).toMatchObject({
      'blockchain.tx.to': USDC,
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(attributes['blockchain.tx.value']).toBeUndefined();
  });

  it('takes the network of a quote-based swap from the quote', async () => {
    const account = await accountOf('createAccount');
    await account.swap!({ swapQuote: { network: 'ethereum' } });
    expect(tracing.spanNamed('send 1')).toBeDefined();
  });

  it('traces useSpendPermission', async () => {
    const account = await accountOf('createAccount');
    await account.useSpendPermission!({ network: 'base', value: 1n });
    expect(tracing.spanNamed('send 8453')).toBeDefined();
  });
});

describe('network-scoped accounts', () => {
  it('trace a send once on a CDP API chain, where the scoped account calls the account', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const account = (await cdp.evm.createAccount!()) as unknown as {
      useNetwork: (n: string) => Promise<Record<string, (o: unknown) => Promise<unknown>>>;
    };
    const scoped = await account.useNetwork('base');
    await scoped.sendTransaction!({ transaction: { to: TO } });
    expect(sends().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('trace sends on other chains, where the SDK sends through viem itself', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const account = (await cdp.evm.createAccount!()) as unknown as {
      useNetwork: (n: string) => Promise<Record<string, (o: unknown) => Promise<unknown>>>;
    };
    const scoped = await account.useNetwork('polygon');
    await scoped.sendTransaction!({ transaction: { to: TO } });
    await scoped.transfer!({ to: TO, amount: 1n, token: 'eth' });
    expect(sends().map((s) => s.name)).toEqual(['send 137', 'send 137']);
  });
});

describe('unexpected inputs and results', () => {
  const accountOf = async (cdp = fakeCdp()) => {
    withHashspan(cdp);
    return (await cdp.evm.createAccount!()) as unknown as Record<
      string,
      (o?: unknown) => Promise<unknown>
    >;
  };

  it('records a send without transaction fields when the transaction is missing or unparseable', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp);
    await cdp.evm.sendTransaction!({ address: ACCOUNT, network: 'base' } as never);
    await cdp.evm.sendTransaction!({ network: 'base', transaction: '0x1234' } as never);
    const [first, second] = sends();
    expect(first?.attributes['blockchain.tx.from']).toBe(ACCOUNT);
    expect(first?.attributes['blockchain.tx.to']).toBeUndefined();
    expect(second?.attributes['blockchain.tx.from']).toBeUndefined();
    expect(second?.attributes['blockchain.tx.to']).toBeUndefined();
  });

  it('fails the send span when the result has no transaction hash, and returns the result', async () => {
    const cdp = fakeCdp();
    cdp.evm.sendTransaction = async () => ({ status: 'pending' });
    withHashspan(cdp);
    await expect(
      cdp.evm.sendTransaction!({ network: 'base', transaction: {} } as never),
    ).resolves.toEqual({ status: 'pending' });
    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe('TypeError');
  });

  it('logs a reader function that throws a non-error, and keeps the send span', async () => {
    const error = vi.spyOn(diag, 'error').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp, {
      reader: () => {
        throw 'no client';
      },
    });
    await cdp.evm.sendTransaction!({ network: 'base', transaction: {} } as never);
    expect(error).toHaveBeenCalledWith('hashspan: the reader function failed (unknown error)');
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('leaves missing methods and non-object factory results alone', async () => {
    const cdp = { evm: { getAccount: async () => undefined, listAccounts: async () => ({}) } };
    withHashspan(cdp as never);
    expect(Object.keys(cdp.evm)).toEqual(['getAccount', 'listAccounts']);
    await expect(cdp.evm.getAccount()).resolves.toBeUndefined();
    await expect(cdp.evm.listAccounts()).resolves.toEqual({});
  });

  it('leaves an account without send methods and a non-object scoped account alone', async () => {
    const cdp = fakeCdp();
    cdp.evm.createAccount = async () => ({ address: ACCOUNT, useNetwork: async () => null });
    const account = await accountOf(cdp);
    expect(account.sendTransaction).toBeUndefined();
    await expect(account.useNetwork!('polygon')).resolves.toBeNull();
  });

  it('records a transfer with a token symbol or missing fields without guessing', async () => {
    const account = await accountOf();
    await account.transfer!({ to: TO, amount: '1', token: 'usdc', network: 'base' });
    await account.transfer!({ token: USDC, network: 'base' });
    const [symbol, bare] = sends();
    expect(symbol?.attributes['blockchain.tx.to']).toBeUndefined();
    expect(symbol?.attributes['blockchain.contract.function.name']).toBe('transfer');
    expect(bare?.attributes['blockchain.tx.to']).toBe(USDC);
    for (const span of [symbol, bare]) {
      expect(span?.attributes['blockchain.tx.value']).toBeUndefined();
    }
  });

  it('passes a call without options through without a span', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const account = await accountOf();
    await expect(account.transfer!()).resolves.toEqual({ transactionHash: HASH });
    expect(sends()).toHaveLength(0);
  });
});
