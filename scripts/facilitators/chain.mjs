// Sets a fresh Anvil up for the facilitator matrix, as hashspan's x402 tests do: Permit2, the x402 Permit2 proxies,
// the batch-settlement contracts and Multicall3 from the runtime code those tests install (copied from Base Sepolia,
// packages/x402/test/{permit2,batch-settlement}/contracts.ts) at their canonical addresses, and TestUsd, an EIP-3009
// token (packages/x402/test/token), as the deployer's first contract. Every payer but the unfunded one gets FUNDS,
// and the payer gives Permit2 an allowance once.
import { createPublicClient, createTestClient, createWalletClient, http, maxUint256 } from 'viem';
import {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_CODE,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_CODE,
  MULTICALL3_ADDRESS,
  MULTICALL3_CODE,
} from '../../packages/x402/test/batch-settlement/contracts.ts';
import {
  EXACT_PROXY_ADDRESS,
  EXACT_PROXY_CODE,
  PERMIT2_ADDRESS,
  PERMIT2_CODE,
  UPTO_PROXY_ADDRESS,
  UPTO_PROXY_CODE,
} from '../../packages/x402/test/permit2/contracts.ts';
import { testUsdAbi, testUsdBytecode } from '../../packages/x402/test/token/test-usd.ts';
import { ACCOUNTS, addressOf, CHAIN_ID, FUNDS, PAY_TO, TOKEN } from './corpus.mjs';

export { BATCH_SETTLEMENT_ADDRESS, testUsdAbi };

/** The matrix chain at an RPC URL. */
export const chainOf = (rpcUrl) => ({
  id: CHAIN_ID,
  name: 'Anvil (facilitator matrix)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

/** The accounts that get tokens. */
const FUNDED = ['payer', 'batchRefund', 'batchFlush', 'batchDynamic'];

/** Installs the contracts and funds the payers on a fresh Anvil; returns the token address. */
export async function setupChain(rpcUrl) {
  const chain = chainOf(rpcUrl);
  const transport = http(rpcUrl);
  const node = createTestClient({ chain, mode: 'anvil', transport });
  const reader = createPublicClient({ chain, transport });
  for (const [address, bytecode] of [
    [PERMIT2_ADDRESS, PERMIT2_CODE],
    [EXACT_PROXY_ADDRESS, EXACT_PROXY_CODE],
    [UPTO_PROXY_ADDRESS, UPTO_PROXY_CODE],
    [BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_CODE],
    [ERC3009_DEPOSIT_COLLECTOR_ADDRESS, ERC3009_DEPOSIT_COLLECTOR_CODE],
    [MULTICALL3_ADDRESS, MULTICALL3_CODE],
  ]) {
    await node.setCode({ address, bytecode });
  }
  // Anvil's accounts are unlocked on the node, so each sends by address.
  const wallet = (key) =>
    createWalletClient({ account: addressOf(ACCOUNTS[key]), chain, transport });
  const deployer = wallet('deployer');
  const hash = await deployer.deployContract({ abi: testUsdAbi, bytecode: testUsdBytecode });
  const { contractAddress } = await reader.waitForTransactionReceipt({ hash });
  if (contractAddress?.toLowerCase() !== TOKEN.toLowerCase()) {
    throw new Error('the token is not where the corpus signed for it: start from a fresh Anvil');
  }
  for (const key of FUNDED) {
    await reader.waitForTransactionReceipt({
      hash: await deployer.writeContract({
        address: TOKEN,
        abi: testUsdAbi,
        functionName: 'mint',
        args: [addressOf(ACCOUNTS[key]), FUNDS],
      }),
    });
  }
  await reader.waitForTransactionReceipt({
    hash: await wallet('payer').writeContract({
      address: TOKEN,
      abi: testUsdAbi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    }),
  });
  return TOKEN;
}

/**
 * Token balances of the receiver, the payers and the batch-settlement contract, as decimal strings.
 * @returns {Promise<Record<string, string>>}
 */
export async function readBalances(rpcUrl) {
  const reader = createPublicClient({ chain: chainOf(rpcUrl), transport: http(rpcUrl) });
  const balance = async (address) =>
    String(
      await reader.readContract({
        address: TOKEN,
        abi: testUsdAbi,
        functionName: 'balanceOf',
        args: [address],
      }),
    );
  const out = { payTo: await balance(PAY_TO), contract: await balance(BATCH_SETTLEMENT_ADDRESS) };
  for (const key of ['payer', 'unfunded', ...FUNDED.slice(1)])
    out[key] = await balance(addressOf(ACCOUNTS[key]));
  return out;
}

/** The token balance of one address, as a decimal string. */
export async function balanceOf(rpcUrl, address) {
  const reader = createPublicClient({ chain: chainOf(rpcUrl), transport: http(rpcUrl) });
  return String(
    await reader.readContract({
      address: TOKEN,
      abi: testUsdAbi,
      functionName: 'balanceOf',
      args: [address],
    }),
  );
}

/** What moved between two balance reads, per account, as signed decimal strings. */
export function moved(before, after) {
  return Object.fromEntries(
    Object.keys(after).map((k) => [k, String(BigInt(after[k]) - BigInt(before[k] ?? '0'))]),
  );
}
