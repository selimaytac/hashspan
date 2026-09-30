import { createTxTracker } from '@hashspan/core';
import { withHashspan as withViemHashspan } from '@hashspan/viem';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, serializeTransaction } from 'viem';
import { base, polygon } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTransport } from '../../viem/test/mock-transport.js';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const HASH = `0x${'ab'.repeat(32)}` as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const USDC = '0x3333333333333333333333333333333333333333';

const viemReceipt = {
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
    async quoteSwap(opts: { network: string }) {
      return fakeQuote(opts.network);
    },
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
        // The SDK waits through its own viem client and returns viem's receipt.
        waitForTransactionReceipt: async () => viemReceipt,
      };
    },
  };
  return account;
}

/** A swap quote shaped like the SDK's: `execute()` sends the swap. */
function fakeQuote(network: string, result: object = { transactionHash: HASH }) {
  return { liquidityAvailable: true, network, execute: async () => result };
}

type Method = (options?: unknown) => Promise<unknown>;
type FakeEvm = Record<
  | 'sendTransaction'
  | 'createAccount'
  | 'getAccount'
  | 'getOrCreateAccount'
  | 'importAccount'
  | 'updateAccount'
  | 'createSwapQuote'
  | 'listAccounts',
  Method
>;
/** A server account as the tests use it, after the factories returned it. */
type TracedAccount = Record<
  'sendTransaction' | 'transfer' | 'swap' | 'quoteSwap' | 'useSpendPermission' | 'useNetwork',
  Method
>;
type ScopedAccount = Record<'sendTransaction' | 'transfer' | 'waitForTransactionReceipt', Method>;

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
    async updateAccount() {
      return fakeAccount(calls);
    }
    async createSwapQuote(opts: { network: string; smartAccount?: unknown }) {
      return opts.smartAccount === undefined
        ? fakeQuote(opts.network)
        : fakeQuote(opts.network, { userOpHash: HASH });
    }
    async listAccounts() {
      return { accounts: [fakeAccount(calls), fakeAccount(calls)] };
    }
  }
  return {
    evm: new EvmClient() as unknown as FakeEvm,
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

    const result = await cdp.evm.sendTransaction({
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
    await cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base', transaction } as never);
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
      cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base', transaction: {} } as never),
    ).rejects.toBe(failure);
    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records the CDP API's error type as error.type", async () => {
    const cdp = fakeCdp();
    const failure = Object.assign(new Error('not enough funds'), {
      name: 'APIError',
      errorType: 'insufficient_balance',
    });
    cdp.evm.sendTransaction = async () => {
      throw failure;
    };
    withHashspan(cdp);
    await expect(cdp.evm.sendTransaction({ network: 'base', transaction: {} })).rejects.toBe(
      failure,
    );
    const send = tracing.spanNamed('send 8453');
    expect(send.attributes['error.type']).toBe('insufficient_balance');
    expect(send.events[0]?.attributes?.['exception.type']).toBe('APIError');
  });

  it('passes calls on unknown networks through without a span, warning once per network', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp);
    for (const network of [
      'moonbase',
      'moonbase',
      'https://rpc.example.invalid/key',
      'https://other.invalid',
    ]) {
      await expect(
        cdp.evm.sendTransaction({ address: ACCOUNT, network, transaction: {} } as never),
      ).resolves.toEqual({ transactionHash: HASH });
    }
    expect(tracing.spans()).toHaveLength(0);
    // An RPC URL can carry an API key: it is never part of the message.
    expect(warn.mock.calls).toEqual([
      ['hashspan: not tracing calls on the unknown CDP network "moonbase"'],
      ['hashspan: not tracing calls on an RPC URL or unknown network'],
    ]);
  });

  it('stops warning about unknown networks after a bounded number of them', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp);
    for (let i = 0; i < 40; i++) {
      await cdp.evm.sendTransaction({ network: `net-${i}`, transaction: {} } as never);
    }
    expect(warn).toHaveBeenCalledTimes(32);
  });

  it('skips a client from a reader function that is on another chain', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const cdp = fakeCdp();
    const other = createPublicClient({ chain: polygon, transport: mockTransport().transport });
    const hashspan = withHashspan(cdp, { reader: () => other });
    await cdp.evm.sendTransaction({ network: 'base', transaction: {} } as never);
    await hashspan.flush();
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: the reader is on chain 137, not 8453; not confirming the transaction',
    );
  });

  it('records only send spans without a reader, and skips a reader on another chain', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const cdp = fakeCdp();
    const other = createPublicClient({ chain: polygon, transport: mockTransport().transport });
    const hashspan = withHashspan(cdp, { reader: other });
    await cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base', transaction: {} } as never);
    await hashspan.flush();
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: the reader is on chain 137, not 8453; not confirming the transaction',
    );
  });

  it('asks a reader function for the chain of the transaction', async () => {
    const cdp = fakeCdp();
    const pick = vi.fn((chainId: number) => (chainId === 8453 ? reader() : undefined));
    const hashspan = withHashspan(cdp, { reader: pick });
    await cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base', transaction: {} } as never);
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
      cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base', transaction: {} } as never),
    ).resolves.toEqual({ transactionHash: HASH });
  });

  it('wraps once when called twice, and returns the first handle', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const cdp = fakeCdp();
    const first = withHashspan(cdp);
    expect(withHashspan(cdp, { reader: reader() })).toBe(first);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: this CDP client is already traced; ignoring the options of the second withHashspan()',
    );
    await cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base', transaction: {} } as never);
    expect(sends()).toHaveLength(1);
  });
});

describe('server accounts', () => {
  const accountOf = async (factory: keyof FakeEvm, cdp = fakeCdp()) => {
    withHashspan(cdp);
    return (await cdp.evm[factory]()) as unknown as TracedAccount;
  };

  for (const factory of [
    'createAccount',
    'getAccount',
    'getOrCreateAccount',
    'importAccount',
    'updateAccount',
  ] as const) {
    it(`traces sends of accounts from ${factory}, with the account as this`, async () => {
      const calls: string[] = [];
      const account = await accountOf(factory, fakeCdp(calls));
      await account.sendTransaction({ network: 'base-sepolia', transaction: { to: TO } });
      expect(calls).toEqual([`send from ${ACCOUNT}`]);
      expect(tracing.spanNamed('send 84532').attributes['blockchain.tx.from']).toBe(ACCOUNT);
    });
  }

  it('wraps an account object once when a factory returns it again', async () => {
    const cdp = fakeCdp();
    const same = fakeAccount();
    cdp.evm.getAccount = async () => same;
    withHashspan(cdp);
    await cdp.evm.getAccount();
    const account = (await cdp.evm.getAccount()) as unknown as TracedAccount;
    await account.sendTransaction({ network: 'base', transaction: {} });
    expect(sends()).toHaveLength(1);
  });

  it('traces accounts returned by listAccounts', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const { accounts } = (await cdp.evm.listAccounts()) as unknown as {
      accounts: TracedAccount[];
    };
    for (const account of accounts)
      await account.sendTransaction({ network: 'base', transaction: {} });
    expect(sends()).toHaveLength(2);
  });

  it('records an ETH transfer as a value transfer', async () => {
    const account = await accountOf('createAccount');
    await account.transfer({ to: TO, amount: 9n, token: 'eth', network: 'base' });
    expect(tracing.spanNamed('send 8453').attributes).toMatchObject({
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '9',
    });
  });

  it('records a token transfer as a call to the token contract', async () => {
    const account = await accountOf('createAccount');
    await account.transfer({ to: { address: TO }, amount: 9n, token: USDC, network: 'base' });
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
    await account.swap({ swapQuote: { network: 'ethereum' } });
    expect(tracing.spanNamed('send 1')).toBeDefined();
  });

  it('traces useSpendPermission', async () => {
    const account = await accountOf('createAccount');
    await account.useSpendPermission({ network: 'base', value: 1n });
    expect(tracing.spanNamed('send 8453')).toBeDefined();
  });
});

describe('network-scoped accounts', () => {
  it('trace a send once on a CDP API chain, where the scoped account calls the account', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const account = (await cdp.evm.createAccount()) as unknown as {
      useNetwork: (n: string) => Promise<ScopedAccount>;
    };
    const scoped = await account.useNetwork('base');
    await scoped.sendTransaction({ transaction: { to: TO } });
    expect(sends().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('trace sends on other chains, where the SDK sends through viem itself', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const account = (await cdp.evm.createAccount()) as unknown as {
      useNetwork: (n: string) => Promise<ScopedAccount>;
    };
    const scoped = await account.useNetwork('polygon');
    await scoped.sendTransaction({ transaction: { to: TO } });
    await scoped.transfer({ to: TO, amount: 1n, token: 'eth' });
    expect(sends().map((s) => s.name)).toEqual(['send 137', 'send 137']);
  });
});

describe('network-scoped accounts on unknown networks', () => {
  it('pass sends through untraced, with a diag message', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp);
    const account = (await cdp.evm.createAccount()) as unknown as {
      useNetwork: (n: string) => Promise<ScopedAccount>;
    };
    const scoped = await account.useNetwork('https://rpc.example.invalid');
    await scoped.sendTransaction({ transaction: { to: TO } });
    expect(sends()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: not tracing calls on an RPC URL or unknown network',
    );
  });
});

describe('unexpected inputs and results', () => {
  const accountOf = async (cdp = fakeCdp()) => {
    withHashspan(cdp);
    return (await cdp.evm.createAccount()) as unknown as TracedAccount;
  };

  it('records a send without transaction fields when the transaction is missing, unparseable or malformed', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const cdp = fakeCdp();
    withHashspan(cdp);
    await cdp.evm.sendTransaction({ address: ACCOUNT, network: 'base' } as never);
    await cdp.evm.sendTransaction({ network: 'base', transaction: '0x1234' } as never);
    await cdp.evm.sendTransaction({ network: 'base', transaction: { to: 42, value: 1 } } as never);
    const [first, second, third] = sends();
    expect(third?.attributes['blockchain.tx.to']).toBeUndefined();
    expect(third?.attributes['blockchain.tx.value']).toBeUndefined();
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
      cdp.evm.sendTransaction({ network: 'base', transaction: {} } as never),
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
    await cdp.evm.sendTransaction({ network: 'base', transaction: {} } as never);
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
    await expect(account.useNetwork('polygon')).resolves.toBeNull();
  });

  it('records a transfer with a token symbol or missing fields without guessing', async () => {
    const account = await accountOf();
    await account.transfer({ to: TO, amount: '1', token: 'usdc', network: 'base' });
    await account.transfer({ token: USDC, network: 'base' });
    const [symbol, bare] = sends();
    expect(symbol?.attributes['blockchain.tx.to']).toBeUndefined();
    expect(symbol?.attributes['blockchain.contract.function.name']).toBe('transfer');
    expect(bare?.attributes['blockchain.tx.to']).toBe(USDC);
    for (const span of [symbol, bare]) {
      expect(span?.attributes['blockchain.tx.value']).toBeUndefined();
    }
  });

  it('passes a call without options through without a span or a warning', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const account = await accountOf();
    await expect(account.transfer()).resolves.toEqual({ transactionHash: HASH });
    expect(sends()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('swap quotes', () => {
  it('trace execute() of a quote from cdp.evm.createSwapQuote, from the taker', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const quote = (await cdp.evm.createSwapQuote({ network: 'base', taker: ACCOUNT })) as {
      execute: () => Promise<unknown>;
    };
    await expect(quote.execute()).resolves.toEqual({ transactionHash: HASH });
    expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.from']).toBe(ACCOUNT);
  });

  it('trace execute() of a quote from account.quoteSwap, from the account', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const account = (await cdp.evm.createAccount()) as {
      quoteSwap: (o: object) => Promise<{ execute: () => Promise<unknown> }>;
    };
    const quote = await account.quoteSwap({ network: 'ethereum' });
    await quote.execute();
    expect(tracing.spanNamed('send 1').attributes['blockchain.tx.from']).toBe(ACCOUNT);
  });

  it('leave quotes for smart accounts alone, which send user operations', async () => {
    const cdp = fakeCdp();
    withHashspan(cdp);
    const quote = (await cdp.evm.createSwapQuote({
      network: 'base',
      taker: ACCOUNT,
      smartAccount: {},
    })) as { execute: () => Promise<unknown> };
    await expect(quote.execute()).resolves.toEqual({ userOpHash: HASH });
    expect(tracing.spans()).toHaveLength(0);
  });
});

describe('sharing a tracker with @hashspan/viem', () => {
  it('records one confirm span when the user also waits for the receipt', async () => {
    const tracker = createTxTracker();
    const cdp = fakeCdp();
    const hashspanCdp = withHashspan(cdp, { tracker, reader: reader() });
    const hashspanViem = withViemHashspan({ tracker });
    const userReader = reader().extend(hashspanViem);

    await cdp.evm.sendTransaction({ network: 'base', transaction: {} } as never);
    await userReader.waitForTransactionReceipt({ hash: HASH });
    await Promise.all([hashspanCdp.flush(), hashspanViem.flush()]);

    const confirms = tracing.spans().filter((s) => s.name === 'confirm 8453');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.links[0]?.context.spanId).toBe(
      tracing.spanNamed('send 8453').spanContext().spanId,
    );
  });

  it('records one confirm span with a reader extended by @hashspan/viem', async () => {
    const tracker = createTxTracker();
    const cdp = fakeCdp();
    const hashspanViem = withViemHashspan({ tracker });
    const hashspanCdp = withHashspan(cdp, { tracker, reader: reader().extend(hashspanViem) });
    await cdp.evm.sendTransaction({ network: 'base', transaction: {} } as never);
    await Promise.all([hashspanCdp.flush(), hashspanViem.flush()]);
    expect(tracing.spans().filter((s) => s.name === 'confirm 8453')).toHaveLength(1);
  });
});

describe("a network-scoped account's waitForTransactionReceipt", () => {
  const scopedOn = async (network: string, cdp = fakeCdp(), options = {}) => {
    const hashspan = withHashspan(cdp, options);
    const account = (await cdp.evm.createAccount()) as unknown as {
      useNetwork: (n: string) => Promise<ScopedAccount>;
    };
    return { hashspan, scoped: await account.useNetwork(network) };
  };

  for (const network of ['base', 'polygon']) {
    it(`records a confirm span from the receipt without a reader, on ${network}`, async () => {
      const { scoped } = await scopedOn(network);
      await scoped.sendTransaction({ transaction: { to: TO } });
      await expect(scoped.waitForTransactionReceipt({ hash: HASH })).resolves.toBe(viemReceipt);
      const chainId = network === 'base' ? 8453 : 137;
      const confirm = tracing.spanNamed(`confirm ${chainId}`);
      expect(confirm.attributes).toMatchObject({
        'blockchain.tx.status': 'success',
        'blockchain.block.number': 123,
        'blockchain.tx.gas.used': 21_000,
        'blockchain.tx.fee': '42000',
      });
      expect(confirm.links[0]?.context.spanId).toBe(
        tracing.spanNamed(`send ${chainId}`).spanContext().spanId,
      );
    });
  }

  it('accepts the transactionHash form of the options', async () => {
    const { scoped } = await scopedOn('base');
    await scoped.waitForTransactionReceipt({ transactionHash: HASH });
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it('leaves the wait to the background confirmation when there is a reader', async () => {
    const tracker = createTxTracker();
    const startConfirm = vi.spyOn(tracker, 'startConfirm');
    const { hashspan, scoped } = await scopedOn('base', fakeCdp(), { tracker, reader: reader() });
    await scoped.sendTransaction({ transaction: { to: TO } });
    await scoped.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    // Only the background confirmation, which also fetches revert reasons, waits for the receipt.
    expect(startConfirm).toHaveBeenCalledTimes(1);
    expect(tracing.spans().filter((s) => s.name === 'confirm 8453')).toHaveLength(1);
  });

  it('ends as a timeout, or as a failure, and rethrows the error', async () => {
    const timeout = Object.assign(new Error('timed out'), {
      name: 'WaitForTransactionReceiptTimeoutError',
    });
    const failure = new Error('rpc down');
    const waits = [timeout, failure];
    for (const error of waits) {
      const failing = await scopedWithWait(async () => {
        throw error;
      });
      await expect(failing.waitForTransactionReceipt({ hash: HASH })).rejects.toBe(error);
    }
    const statuses = tracing
      .spans()
      .filter((s) => s.name === 'confirm 8453')
      .map((s) => [s.attributes['blockchain.tx.status'], s.attributes['error.type']]);
    expect(statuses).toEqual([
      ['timeout', 'timeout'],
      [undefined, 'Error'],
    ]);
  });

  it('fails the confirm span when the result is not a receipt, and returns it', async () => {
    const odd = await scopedWithWait(async () => ({ status: 'pending' }));
    await expect(odd.waitForTransactionReceipt({ hash: HASH })).resolves.toEqual({
      status: 'pending',
    });
    expect(tracing.spanNamed('confirm 8453').attributes['error.type']).toBe('TypeError');
  });

  it('passes a wait without a hash through untraced', async () => {
    const { scoped } = await scopedOn('base');
    await scoped.waitForTransactionReceipt({});
    expect(tracing.spans()).toHaveLength(0);
  });
});

/** A network-scoped account on Base whose SDK wait is `wait`, traced by the adapter. */
async function scopedWithWait(wait: Method): Promise<ScopedAccount> {
  const cdp = fakeCdp();
  cdp.evm.createAccount = async () => ({
    address: ACCOUNT,
    useNetwork: async (network: string) => ({
      address: ACCOUNT,
      network,
      waitForTransactionReceipt: wait,
    }),
  });
  withHashspan(cdp);
  const account = (await cdp.evm.createAccount()) as unknown as {
    useNetwork: (n: string) => Promise<ScopedAccount>;
  };
  return account.useNetwork('base');
}
