import { type Chain, createPublicClient } from 'viem';
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
  };
}

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
    expect(
      await confirmOn(celo, {
        l1Fee: '0x1388',
        feeCurrency: `0x${'33'.repeat(20)}`,
      }),
    ).toEqual({ fee: '21000000005000', l1Fee: '5000', status: 'success' });
  });
});
