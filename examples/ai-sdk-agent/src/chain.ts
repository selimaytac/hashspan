import { withHashspan } from '@hashspan/viem';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  type Hex,
  http,
  parseAbi,
} from 'viem';
import { anvil } from 'viem/chains';

export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

/** Anvil's first test account; Anvil signs for it, so no private key is needed here. */
const TREASURY: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

export const vendor: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const vault: Address = '0x00000000000000000000000000000000000000aa';
export const vaultAbi = parseAbi([
  'function withdraw(uint256 amount)',
  'error WithdrawalLimitExceeded(uint256 limit, uint256 requested)',
]);

// One withHashspan() result for both clients, so confirm spans link to their send spans.
export const hashspan = withHashspan({
  agent: { name: 'treasury-agent' },
  recordFunctionArguments: true,
});

export const wallet = createWalletClient({
  account: TREASURY,
  chain: anvil,
  transport: http(RPC_URL),
  // Anvil mines instantly; viem would otherwise poll for receipts every 4 s.
  pollingInterval: 250,
}).extend(hashspan);

export const reader = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
  pollingInterval: 250,
}).extend(hashspan);

/** Runtime bytecode that stores `payload` in memory and reverts with it. */
function revertingWith(payload: Hex): Hex {
  const bytes = payload.slice(2);
  const size = bytes.length / 2;
  let code = '';
  for (let offset = 0; offset < size; offset += 32) {
    const word = bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0');
    code += `7f${word}60${offset.toString(16).padStart(2, '0')}52`;
  }
  return `0x${code}60${size.toString(16).padStart(2, '0')}6000fd`;
}

/**
 * Installs a demo vault on the local chain that rejects every withdrawal with a custom error, so the demo can show
 * a reverted transaction and its decoded reason.
 */
export async function installDemoVault(): Promise<void> {
  const code = revertingWith(
    encodeErrorResult({
      abi: vaultAbi,
      errorName: 'WithdrawalLimitExceeded',
      args: [10n ** 17n, 10n ** 18n],
    }),
  );
  await reader.request({ method: 'anvil_setCode' as never, params: [vault, code] as never });
}
