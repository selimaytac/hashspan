import { type Chain, createPublicClient, defineChain } from 'viem';
import * as chains from 'viem/chains';
import { arbitrum, base, celo, mainnet, scroll, zksync } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Fee attributes per chain family: each receipt is formatted by the viem chain the reader is on, with the fields
// that family adds (shapes as its nodes return them; values are made up). The mock receipt uses 21 000 gas at
// 1 gwei, so the execution fee is 21 000 000 000 000 wei.

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const EXECUTION_FEE = '21000000000000';

async function confirmOn(chain: Chain, receipt: Record<string, unknown> = {}) {
  const reader = createPublicClient({
    chain,
    transport: mockTransport({ chainIdHex: `0x${chain.id.toString(16)}`, receipt }).transport,
  }).extend(withHashspan());
  await reader.waitForTransactionReceipt({ hash: HASH });
  const attributes = tracing.spanNamed(`confirm ${chain.id}`).attributes;
  return {
    fee: attributes['blockchain.tx.fee'],
    l1Fee: attributes['blockchain.tx.l1_fee'],
    status: attributes['blockchain.tx.status'],
    ...(attributes['blockchain.tx.fee_asset'] !== undefined
      ? { feeAsset: attributes['blockchain.tx.fee_asset'] }
      : {}),
  };
}

/** A Tempo fee token, in mixed letter case as a node may return it. */
const FEE_TOKEN = '0x20C0000000000000000000000000000000000001';
/** Tempo's transaction type: viem's receipt formatter keeps it as the raw `0x76`. */
const TEMPO_RECEIPT = { type: '0x76', feeToken: FEE_TOKEN, feePayer: `0x${'44'.repeat(20)}` };
/** A chain with Tempo's localnet id, which is no Tempo-only id: the filter is on the receipt type. */
const tempoLocal = defineChain({
  id: 1337,
  name: 'Tempo localnet',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});
const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
});

describe('fee attributes per chain family', () => {
  it('Ethereum: the execution fee, and no L1 fee attribute', async () => {
    expect(await confirmOn(mainnet)).toEqual({
      fee: EXECUTION_FEE,
      l1Fee: undefined,
      status: 'success',
    });
  });

  it('OP Stack (Base): the execution fee plus the L1 data fee of the receipt', async () => {
    expect(
      await confirmOn(base, {
        l1Fee: '0x1388',
        l1GasUsed: '0x640',
        l1GasPrice: '0x3b9aca00',
        l1BaseFeeScalar: '0x8dd',
        l1BlobBaseFee: '0x1',
        l1BlobBaseFeeScalar: '0x101c12',
      }),
    ).toEqual({ fee: '21000000005000', l1Fee: '5000', status: 'success' });
  });

  it('Arbitrum: gasUsed already includes the L1 component, so no L1 fee attribute', async () => {
    expect(
      await confirmOn(arbitrum, { gasUsedForL1: '0x1f4', l1BlockNumber: '0x1406f40' }),
    ).toEqual({
      fee: EXECUTION_FEE,
      l1Fee: undefined,
      status: 'success',
    });
  });

  it('Scroll: the L1 data fee of the receipt, unformatted by viem', async () => {
    expect(await confirmOn(scroll, { l1Fee: '0x1388' })).toEqual({
      fee: '21000000005000',
      l1Fee: '5000',
      status: 'success',
    });
  });

  it('ZKsync: a receipt in its own format, with the execution fee', async () => {
    expect(
      await confirmOn(zksync, {
        l1BatchNumber: '0x7d0',
        l1BatchTxIndex: '0x1',
        logs: [],
        l2ToL1Logs: [],
      }),
    ).toEqual({ fee: EXECUTION_FEE, l1Fee: undefined, status: 'success' });
  });

  it('Celo: the receipt values as given, including its L1 data fee; no fee currency is converted', async () => {
    // Only the transaction names a fee currency: one on a receipt is not read (the sending call's is, see
    // fee-asset.test.ts).
    expect(
      await confirmOn(celo, {
        l1Fee: '0x1388',
        type: '0x7b',
        feeCurrency: `0x${'33'.repeat(20)}`,
      }),
    ).toEqual({ fee: '21000000005000', l1Fee: '5000', status: 'success' });
  });

  it('Tempo: the execution fee in attodollars, and the fee token of a 0x76 receipt, lower-cased', async () => {
    expect(await confirmOn(tempoLocal, TEMPO_RECEIPT)).toEqual({
      fee: EXECUTION_FEE,
      l1Fee: undefined,
      status: 'success',
      feeAsset: FEE_TOKEN.toLowerCase(),
    });
  });

  // viem's Tempo chain, with its own formatters, came with viem 2.43.0.
  it.skipIf(!('tempo' in chains))(
    "Tempo with viem's chain formatter: the receipt keeps its raw type and fee token",
    async () => {
      const tempo = (chains as unknown as Record<string, Chain>).tempo as Chain;
      expect(await confirmOn(tempo, TEMPO_RECEIPT)).toMatchObject({
        fee: EXECUTION_FEE,
        feeAsset: FEE_TOKEN.toLowerCase(),
      });
    },
  );

  it.each([
    ['of another type', { ...TEMPO_RECEIPT, type: '0x2' }],
    ['without a type', { ...TEMPO_RECEIPT, type: undefined }],
    ['with a malformed fee token', { ...TEMPO_RECEIPT, feeToken: `${FEE_TOKEN}00` }],
    ['with a fee token that is no string', { ...TEMPO_RECEIPT, feeToken: 42 }],
  ])('Tempo: no fee asset from a receipt %s (fails closed)', async (_name, receipt) => {
    expect(await confirmOn(tempoLocal, receipt)).toEqual({
      fee: EXECUTION_FEE,
      l1Fee: undefined,
      status: 'success',
    });
  });

  it('Arc: the execution fee in its native USDC, with no fee asset', async () => {
    expect(await confirmOn(arc)).toEqual({
      fee: EXECUTION_FEE,
      l1Fee: undefined,
      status: 'success',
    });
  });
});
