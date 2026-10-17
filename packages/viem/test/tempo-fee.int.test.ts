// The token a Tempo fee was paid in (ADR 0028, #429), against Anvil in Tempo mode (`--network tempo`): on Tempo every
// transaction pays its fee in a token, a plain EIP-1559 one too, and its receipt names `feeToken` and `feePayer`.
// Anvil rejects native value transfers in Tempo mode, so the transactions send calldata without value.
import { createTxTracker } from '@hashspan/core';
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hash,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as chains from 'viem/chains';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordingMeterProvider } from '../../core/test/hostile.js';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

/** Tempo's localnet chain id, which viem's `tempoLocalnet` uses. */
const CHAIN_ID = 1337;
/** Anvil's first test account, funded on every Anvil chain. */
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const signer = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const RECIPIENT = '0x000000000000000000000000000000000000dEaD' as const;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: CHAIN_ID,
  network: 'tempo',
});

/** A chain with Tempo's localnet id and no Tempo formatter: the adapter imports no chain module. */
const plainChain = defineChain({
  id: CHAIN_ID,
  name: 'Anvil in Tempo mode',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});
afterAll(async () => {
  await instance.stop();
});

/** Sends with `send`, waits for the receipt, and returns what the confirm span, the fee sample and the node say. */
async function feeOf(
  chain: Chain,
  send: (wallet: ReturnType<typeof walletOf>) => Promise<Hash>,
  account: typeof signer | typeof SENDER = signer,
) {
  const meters = recordingMeterProvider();
  const hashspan = withHashspan({
    tracker: createTxTracker({ meterProvider: meters.provider }),
  });
  const wallet = walletOf(chain, account).extend(hashspan);
  const reader = createPublicClient({
    chain,
    transport: http(RPC_URL),
    pollingInterval: 50,
  }).extend(hashspan);
  const hash = await send(wallet as never);
  await reader.waitForTransactionReceipt({ hash });
  await hashspan.flush();
  const receipt = (await reader.request({
    method: 'eth_getTransactionReceipt',
    params: [hash],
  })) as Record<string, unknown>;
  const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes;
  const fees = meters.samples().filter(({ name }) => name === 'blockchain.client.fee');
  return {
    receipt,
    feeAsset: confirm['blockchain.tx.fee_asset'],
    fee: confirm['blockchain.tx.fee'],
    denominations: fees.map(({ attributes }) => attributes['blockchain.fee.denomination']),
  };
}

function walletOf(chain: Chain, account: typeof signer | typeof SENDER) {
  return createWalletClient({ account, chain, transport: http(RPC_URL), pollingInterval: 50 });
}

describe('Tempo fees on Anvil in Tempo mode', () => {
  it.each([
    ['a local account', signer, 'eip1559'],
    ['a local account, as a legacy transaction', signer, 'legacy'],
    ['a JSON-RPC account (eth_sendTransaction)', SENDER, undefined],
  ] as const)(
    'records the fee token of a plain transaction from %s, and marks the fee sample',
    async (_name, account, type) => {
      const { receipt, feeAsset, fee, denominations } = await feeOf(
        plainChain,
        (wallet) =>
          wallet.sendTransaction({
            to: RECIPIENT,
            data: '0x1234',
            ...(type ? { type } : {}),
          } as never),
        account,
      );
      // The node's own receipt: not of Tempo's type, and yet it names the fee token and the fee payer.
      expect(receipt.type).toBe(type === 'legacy' ? '0x0' : '0x2');
      expect(receipt.feePayer).toBe(SENDER.toLowerCase());
      expect(typeof receipt.feeToken).toBe('string');
      expect(feeAsset).toBe((receipt.feeToken as string).toLowerCase());
      expect(fee).toBe(
        (
          BigInt(receipt.gasUsed as string) * BigInt(receipt.effectiveGasPrice as string)
        ).toString(),
      );
      expect(denominations).toEqual(['token']);
    },
  );

  // viem's Tempo chains, which send type 0x76 when a call names a fee token, came with viem 2.43.0.
  const tempoLocalnet = (chains as unknown as Record<string, Chain | undefined>).tempoLocalnet;
  it.skipIf(tempoLocalnet === undefined)(
    'records the fee token of a Tempo transaction (type 0x76) as before',
    async () => {
      const chain = { ...(tempoLocalnet as Chain), rpcUrls: { default: { http: [RPC_URL] } } };
      const FEE_TOKEN = '0x20c0000000000000000000000000000000000001';
      const { receipt, feeAsset, denominations } = await feeOf(chain, (wallet) =>
        wallet.sendTransaction({ to: RECIPIENT, data: '0x1234', feeToken: FEE_TOKEN } as never),
      );
      expect(receipt.type).toBe('0x76');
      expect(feeAsset).toBe(FEE_TOKEN);
      expect(denominations).toEqual(['token']);
    },
  );
});
