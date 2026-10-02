import {
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { type DemoChain, deployCode, hashspan, vaultCode, WITHDRAW_GAS } from './chain.js';

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const EXPLORER = 'https://sepolia.basescan.org';

const PAY_ETH = '0.00001';
const WITHDRAW_ETH = '0.00002';
const WITHDRAW_LIMIT_ETH = '0.00001';

/** A setup problem whose message is safe to print: it never contains the key or the RPC URL. */
export class DemoSetupError extends Error {
  override name = 'DemoSetupError';
}

interface BaseSepoliaEnv {
  privateKey: Hex;
  rpcUrl: string;
}

/** Reads the testnet key and RPC URL from the environment, without ever echoing them back. */
export function readBaseSepoliaEnv(env: NodeJS.ProcessEnv): BaseSepoliaEnv {
  const privateKey = env.BASE_SEPOLIA_PRIVATE_KEY;
  if (!privateKey) throw new DemoSetupError('BASE_SEPOLIA_PRIVATE_KEY is not set.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new DemoSetupError('BASE_SEPOLIA_PRIVATE_KEY must be 0x followed by 64 hex characters.');
  }
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  let protocol: string;
  try {
    protocol = new URL(rpcUrl).protocol;
  } catch {
    throw new DemoSetupError('BASE_SEPOLIA_RPC_URL is not a valid URL.');
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new DemoSetupError('BASE_SEPOLIA_RPC_URL must be an http or https URL.');
  }
  return { privateKey: privateKey as Hex, rpcUrl };
}

/**
 * Base Sepolia, with the account of `BASE_SEPOLIA_PRIVATE_KEY`. Refuses any other chain, checks that the balance
 * covers the run, and deploys a demo vault that rejects every withdrawal. The deployment is not traced: it is setup,
 * not something the agent does. The vendor is the account itself, so the payment comes back.
 */
export async function baseSepoliaChain(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<DemoChain> {
  const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
  const setup = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const chainId = await setup.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new DemoSetupError(
      `The RPC reports chain id ${chainId}; this demo only runs on Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}).`,
    );
  }

  const account = privateKeyToAccount(privateKey);
  const creation = deployCode(vaultCode(parseEther(WITHDRAW_LIMIT_ETH), parseEther(WITHDRAW_ETH)));
  const [balance, { maxFeePerGas }, deployGas] = await Promise.all([
    setup.getBalance({ address: account.address }),
    setup.estimateFeesPerGas(),
    setup.estimateGas({ account: account.address, data: creation }),
  ]);
  // viem reserves gas limit x max fee per transaction; double it to leave room for the L1 data fee and fee changes.
  const needed = 2n * (deployGas + 21_000n + WITHDRAW_GAS) * maxFeePerGas + parseEther(PAY_ETH);
  log(`Account ${account.address} holds ${formatEther(balance)} ETH on Base Sepolia.`);
  if (balance < needed) {
    throw new DemoSetupError(
      `The run needs about ${formatEther(needed)} ETH; fund ${account.address} from a Base Sepolia faucet.`,
    );
  }

  const deployer = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const deployment = await deployer.sendTransaction({ data: creation, gas: deployGas });
  const { contractAddress } = await setup.waitForTransactionReceipt({ hash: deployment });
  const code = contractAddress ? await setup.getCode({ address: contractAddress }) : undefined;
  if (!contractAddress || !code || code === '0x') {
    throw new DemoSetupError(`The demo vault was not deployed: ${EXPLORER}/tx/${deployment}`);
  }
  log(`Demo vault deployed at ${contractAddress}: ${EXPLORER}/tx/${deployment}`);

  return {
    wallet: createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) }).extend(
      hashspan,
    ),
    reader: createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }).extend(hashspan),
    vendor: account.address,
    vault: contractAddress,
    payEth: PAY_ETH,
    withdrawEth: WITHDRAW_ETH,
  };
}
