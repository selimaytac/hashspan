import { createTxTracker } from '@hashspan/core';
import { withHashspan } from '@hashspan/viem';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PrivateKeyAccount,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
// The EIP-3009 test token of hashspan's x402 tests: anyone can mint it, so it is for local chains only.
import { testUsdAbi, testUsdBytecode } from '../../../packages/x402/test/token/test-usd.js';

export const AGENT_NAME = 'research-agent';

/** The x402 network id of the local chain: Anvil's default chain id, 31337. */
export const NETWORK = `eip155:${foundry.id}` as const;

/** The report's price in Test USD's smallest unit (6 decimals): 0.01 Test USD. */
export const REPORT_PRICE = 10_000n;

/** The agent's spend controls: at most 0.05 Test USD per payment. */
export const MAX_PER_PAYMENT = 50_000n;

/** Anvil's first test account, unlocked on the node: it deploys the token and, as the facilitator, settles payments. */
const FACILITATOR: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
/** Anvil's second test account: the paid API's seller, paid in Test USD. */
export const SELLER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** Anvil's third test account: the report's author, whom the agent tips in ETH. */
export const AUTHOR: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// One tracker for both adapters, so the agent identity is set once and every span carries it.
export const tracker = createTxTracker({ agent: { name: AGENT_NAME } });
// One withHashspan() result for every viem client, so confirm spans link to their send spans.
export const hashspan = withHashspan({ tracker });

/** Everything the agent and the paid API need on the local chain. */
export interface LocalChain {
  rpcUrl: string;
  /** The agent's own account, made for this run: it sends the tip and signs the x402 payment. */
  agent: PrivateKeyAccount;
  /** Test USD, deployed for this run. */
  token: Address;
  /** A plain public client: the x402 adapter's reader, and the facilitator's view of the chain. */
  reader: ReturnType<typeof readerFor>;
  /** Anvil's first account as a wallet with public actions: the facilitator's signer. */
  facilitatorWallet: ReturnType<typeof facilitatorWalletFor>;
}

const readerFor = (rpcUrl: string) =>
  // Anvil mines instantly; viem would otherwise poll for receipts every 4 s.
  createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 250 });

const facilitatorWalletFor = (rpcUrl: string) =>
  createWalletClient({
    account: FACILITATOR,
    chain: foundry,
    transport: http(rpcUrl),
    pollingInterval: 250,
  }).extend(publicActions);

/**
 * Prepares the local Anvil chain at `rpcUrl`: a fresh agent account with 1 ETH (set with `anvil_setBalance`) and
 * 1 Test USD, minted from a Test USD contract deployed for this run. Setup is not traced: it is not the agent's work.
 */
export async function prepareLocalChain(rpcUrl: string): Promise<LocalChain> {
  const reader = readerFor(rpcUrl);
  const facilitatorWallet = facilitatorWalletFor(rpcUrl);
  const agent = privateKeyToAccount(generatePrivateKey());

  await reader.request({
    method: 'anvil_setBalance' as never,
    params: [agent.address, `0x${(10n ** 18n).toString(16)}` as Hex] as never,
  });
  const deployment = await facilitatorWallet.deployContract({
    abi: testUsdAbi,
    bytecode: testUsdBytecode,
  });
  const { contractAddress } = await reader.waitForTransactionReceipt({ hash: deployment });
  const token = contractAddress as Address;
  await reader.waitForTransactionReceipt({
    hash: await facilitatorWallet.writeContract({
      address: token,
      abi: testUsdAbi,
      functionName: 'mint',
      args: [agent.address, 1_000_000n],
    }),
  });
  return { rpcUrl, agent, token, reader, facilitatorWallet };
}

/** The agent's wallet and receipt reader, both extended with hashspan. */
export function tracedClients({ rpcUrl, agent }: LocalChain) {
  return {
    wallet: createWalletClient({
      account: agent,
      chain: foundry,
      transport: http(rpcUrl),
      pollingInterval: 250,
    }).extend(hashspan),
    receipts: readerFor(rpcUrl).extend(hashspan),
  };
}
