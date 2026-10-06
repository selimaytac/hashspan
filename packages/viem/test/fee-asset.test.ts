// The token a fee was paid in (ADR 0028): Celo's `feeCurrency` from the sending call, Tempo's `feeToken` from a
// receipt of type 0x76, recorded as `blockchain.tx.fee_asset` and marked on the fee sample, with no extra request.
import { createTxTracker } from '@hashspan/core';
import { createPublicClient, createWalletClient, parseAbi, serializeTransaction } from 'viem';
import { celo } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingMeterProvider } from '../../core/test/hostile.js';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, type MockOptions, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemHasAction } from './viem-version.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const CHAIN_ID_HEX = `0x${celo.id.toString(16)}`;
/** A fee currency in mixed letter case, as a caller may pass it. */
const FEE_CURRENCY = '0x765DE816845861e75A25fCA122bb6898B8B1282a';
const FEE_CURRENCY_LOWER = FEE_CURRENCY.toLowerCase();
const OTHER_CURRENCY = `0x${'77'.repeat(20)}`;
const MINED = `0x${'cd'.repeat(32)}` as const;
const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

/** Clients on a mock Celo node, extended with one `withHashspan()` result that records metrics. */
function clients(node: MockOptions = {}, options: Parameters<typeof withHashspan>[0] = {}) {
  const meters = recordingMeterProvider();
  const hashspan = withHashspan({
    tracker: createTxTracker({ meterProvider: meters.provider }),
    ...options,
  });
  const mock = mockTransport({ chainIdHex: CHAIN_ID_HEX, retryCount: 0, ...node });
  const wallet = createWalletClient({
    account: FROM,
    chain: celo,
    transport: mock.transport,
    pollingInterval: 10,
  }).extend(hashspan);
  const reader = createPublicClient({
    chain: celo,
    transport: mock.transport,
    pollingInterval: 10,
  }).extend(hashspan);
  const denominations = () =>
    meters
      .samples()
      .filter(({ name }) => name === 'blockchain.client.fee')
      .map(({ attributes }) => attributes['blockchain.fee.denomination']);
  return { hashspan, wallet, reader, mock, denominations };
}

/** The requests the same calls make on a mock node without hashspan. */
async function untracedCalls(
  run: (wallet: ReturnType<typeof createWalletClient>) => Promise<unknown>,
  node: MockOptions = {},
): Promise<string[]> {
  const mock = mockTransport({ chainIdHex: CHAIN_ID_HEX, retryCount: 0, ...node });
  const wallet = createWalletClient({
    account: FROM,
    chain: celo,
    transport: mock.transport,
    pollingInterval: 10,
  });
  await run(wallet);
  return mock.calls;
}

const confirmOf = (hash: string = HASH) =>
  tracing
    .spans()
    .find((s) => s.name === `confirm ${celo.id}` && s.attributes['blockchain.tx.hash'] === hash);

describe("Celo: the sending call's fee currency", () => {
  it('records it, lower-cased, on the confirm span of sendTransaction and marks the fee sample, with no request more', async () => {
    const { hashspan, wallet, reader, mock, denominations } = clients();
    const hash = await wallet.sendTransaction({
      to: TO,
      value: 1n,
      feeCurrency: FEE_CURRENCY,
    } as never);
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();

    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
    expect(denominations()).toEqual(['token']);
    const send = tracing.spans().find((s) => s.name === `send ${celo.id}`);
    expect(send?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    // The same requests as the calls without hashspan: the asset is read from the call, not the chain.
    const plain = mockTransport({ chainIdHex: CHAIN_ID_HEX, retryCount: 0 });
    const plainWallet = createWalletClient({
      account: FROM,
      chain: celo,
      transport: plain.transport,
    });
    const plainReader = createPublicClient({
      chain: celo,
      transport: plain.transport,
      pollingInterval: 10,
    });
    await plainReader.waitForTransactionReceipt({
      hash: await plainWallet.sendTransaction({
        to: TO,
        value: 1n,
        feeCurrency: FEE_CURRENCY,
      } as never),
    });
    expect(mock.calls).toEqual(plain.calls);
  });

  it('records it for writeContract', async () => {
    const { hashspan, wallet, reader, denominations } = clients();
    const hash = await wallet.writeContract({
      address: TO,
      abi: erc20,
      functionName: 'transfer',
      args: [TO, 1n],
      feeCurrency: FEE_CURRENCY,
    } as never);
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();
    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
    expect(denominations()).toEqual(['token']);
  });

  // sendTransactionSync and writeContractSync came with viem 2.38.0.
  const SYNC = viemHasAction('sendTransactionSync') && viemHasAction('writeContractSync');
  const syncCalls = {
    sendTransactionSync: { to: TO, value: 1n, feeCurrency: FEE_CURRENCY, timeout: 1_000 },
    writeContractSync: {
      address: TO,
      abi: erc20,
      functionName: 'transfer',
      args: [TO, 1n],
      feeCurrency: FEE_CURRENCY,
      timeout: 1_000,
    },
  };
  it.skipIf(!SYNC).each(Object.keys(syncCalls))(
    'records it for %s, with the same requests as without hashspan',
    async (action) => {
      const args = syncCalls[action as keyof typeof syncCalls];
      // biome-ignore lint/suspicious/noExplicitAny: the sync actions are missing from the floor's types.
      const run = (client: any) => client[action](args);
      const { hashspan, wallet, mock, denominations } = clients();
      await run(wallet);
      await hashspan.flush();
      expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
      expect(denominations()).toEqual(['token']);
      expect(mock.calls).toEqual(await untracedCalls(run));
    },
  );

  it('records it with background confirmation', async () => {
    const background = clients({}, { confirm: { mode: 'background' } });
    await background.wallet.sendTransaction({ to: TO, feeCurrency: FEE_CURRENCY } as never);
    await background.hashspan.flush();
    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
    expect(background.denominations()).toEqual(['token']);
  });

  it('records it with watch() on the extension that traced the send', async () => {
    const watched = clients();
    await watched.wallet.sendTransaction({ to: TO, feeCurrency: FEE_CURRENCY } as never);
    watched.hashspan.watch(watched.reader, { hash: HASH });
    await watched.hashspan.flush();
    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY_LOWER);
    expect(watched.denominations()).toEqual(['token']);
  });

  it('records none for a transaction confirmed with watch() alone: only the transaction names it', async () => {
    const { hashspan, reader, mock, denominations } = clients({
      receipt: { type: '0x7b', feeCurrency: FEE_CURRENCY },
      transaction: { type: '0x7b', feeCurrency: FEE_CURRENCY },
    });
    hashspan.watch(reader, { hash: HASH });
    await hashspan.flush();
    expect(confirmOf()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual([undefined]);
    // The transaction is not read to find it.
    expect(mock.calls).not.toContain('eth_getTransactionByHash');
  });

  it('records none for sendRawTransaction', async () => {
    const { hashspan, wallet, reader, denominations } = clients();
    const hash = await wallet.sendRawTransaction({
      serializedTransaction: serializeTransaction({
        chainId: celo.id,
        to: TO,
        value: 1n,
        gas: 21_000n,
        nonce: 1,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      }),
    });
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();
    expect(confirmOf()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual([undefined]);
  });

  it.each([
    ['too short', `0x${'ab'.repeat(19)}`],
    ['not hex', `0x${'zz'.repeat(20)}`],
    ['a number', 42],
  ])('drops a fee currency that is %s', async (_name, feeCurrency) => {
    const { hashspan, wallet, reader, denominations } = clients();
    await reader.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: TO, feeCurrency } as never),
    });
    await hashspan.flush();
    expect(confirmOf()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual([undefined]);
  });

  it('runs no getter of the call to read it', async () => {
    const { hashspan, wallet, reader } = clients();
    const read = vi.fn(() => FEE_CURRENCY);
    const args = Object.defineProperty({ to: TO }, 'feeCurrency', {
      get: read,
      enumerable: true,
    });
    const hash = await wallet.sendTransaction(args as never);
    const readsByViem = read.mock.calls.length;
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();
    // viem itself may read it; telemetry adds no read and records nothing from an accessor.
    const untraced = vi.fn(() => FEE_CURRENCY);
    const plain = createWalletClient({
      account: FROM,
      chain: celo,
      transport: mockTransport({ chainIdHex: CHAIN_ID_HEX }).transport,
    });
    await plain.sendTransaction(
      Object.defineProperty({ to: TO }, 'feeCurrency', {
        get: untraced,
        enumerable: true,
      }) as never,
    );
    expect(readsByViem).toBe(untraced.mock.calls.length);
    expect(confirmOf()?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
  });
});

describe('replacements', () => {
  const minedReceipt = {
    transactionHash: MINED,
    status: 'success' as const,
    blockNumber: 124n,
    gasUsed: 21_000n,
    effectiveGasPrice: 2n,
  };

  /** A reader whose wait reports that `transaction` replaced the awaited one, as viem does. */
  function replacing(fields: PropertyDescriptorMap) {
    const meters = recordingMeterProvider();
    const hashspan = withHashspan({ tracker: createTxTracker({ meterProvider: meters.provider }) });
    const mock = mockTransport({ chainIdHex: CHAIN_ID_HEX });
    const plainWallet = createWalletClient({
      account: FROM,
      chain: celo,
      transport: mock.transport,
    });
    const wallet = plainWallet.extend(hashspan);
    const reader = createPublicClient({ chain: celo, transport: mock.transport })
      .extend(() => ({
        waitForTransactionReceipt: async (args: { onReplaced?: (r: unknown) => void }) => {
          args.onReplaced?.({
            reason: 'repriced',
            replacedTransaction: { hash: HASH, to: TO },
            // Defined, not spread, so that a getter of the test stays a getter.
            transaction: Object.defineProperties({ hash: MINED, to: TO }, fields),
            transactionReceipt: minedReceipt,
          });
          return minedReceipt;
        },
      }))
      .extend(hashspan);
    const denominations = () =>
      meters
        .samples()
        .filter(({ name }) => name === 'blockchain.client.fee')
        .map(({ attributes }) => attributes['blockchain.fee.denomination']);
    return { hashspan, wallet, reader, denominations };
  }

  it("records the replacing transaction's own fee currency", async () => {
    const { hashspan, wallet, reader, denominations } = replacing({
      feeCurrency: { value: OTHER_CURRENCY, enumerable: true },
    });
    await reader.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: TO, feeCurrency: FEE_CURRENCY } as never),
    });
    await hashspan.flush();
    expect(confirmOf(MINED)?.attributes['blockchain.tx.fee_asset']).toBe(OTHER_CURRENCY);
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBe('replaced');
    expect(confirmOf(HASH)?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual(['token']);
  });

  it("never inherits the replaced transaction's fee currency", async () => {
    const { hashspan, wallet, reader, denominations } = replacing({});
    await reader.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: TO, feeCurrency: FEE_CURRENCY } as never),
    });
    await hashspan.flush();
    expect(confirmOf(MINED)?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
    expect(denominations()).toEqual([undefined]);
  });

  it('runs no getter of the replacing transaction', async () => {
    const read = vi.fn(() => OTHER_CURRENCY);
    const { hashspan, reader } = replacing({ feeCurrency: { get: read, enumerable: true } });
    await reader.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    expect(read).not.toHaveBeenCalled();
    expect(confirmOf(MINED)?.attributes).not.toHaveProperty('blockchain.tx.fee_asset');
  });
});

describe('Tempo: the fee token of a 0x76 receipt', () => {
  const FEE_TOKEN = '0x20C0000000000000000000000000000000000001';

  it('records it with no request more than the wait without hashspan', async () => {
    const node = { receipt: { type: '0x76', feeToken: FEE_TOKEN } };
    const { hashspan, reader, mock, denominations } = clients(node);
    await reader.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_TOKEN.toLowerCase());
    expect(denominations()).toEqual(['token']);
    const plain = mockTransport({ chainIdHex: CHAIN_ID_HEX, retryCount: 0, ...node });
    await createPublicClient({ chain: celo, transport: plain.transport }).waitForTransactionReceipt(
      {
        hash: HASH,
      },
    );
    expect(mock.calls).toEqual(plain.calls);
  });

  it('records it from the sealed receipt only, after a preconfirmation', async () => {
    const { hashspan, reader } = clients({
      receipt: { type: '0x76', feeToken: FEE_TOKEN },
      receiptAt: (call) =>
        call === 1 ? { blockHash: `0x${'00'.repeat(32)}`, feeToken: `0x${'99'.repeat(20)}` } : {},
    });
    await reader.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_TOKEN.toLowerCase());
  });

  it("takes the receipt's fee token over the call's fee currency", async () => {
    const { hashspan, wallet, reader } = clients({
      receipt: { type: '0x76', feeToken: FEE_TOKEN },
    });
    await reader.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: TO, feeCurrency: FEE_CURRENCY } as never),
    });
    await hashspan.flush();
    expect(confirmOf()?.attributes['blockchain.tx.fee_asset']).toBe(FEE_TOKEN.toLowerCase());
  });
});
