import { withHashspan } from '@hashspan/viem';
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  type Hex,
  http,
  type PublicClient,
  parseAbi,
  type Transport,
  type WalletClient,
} from 'viem';
import { anvil } from 'viem/chains';

export const vaultAbi = parseAbi([
  'function withdraw(uint256 amount)',
  'error WithdrawalLimitExceeded(uint256 limit, uint256 requested)',
]);

/** Gas the withdrawal is sent with. */
export const WITHDRAW_GAS = 100_000n;

// One withHashspan() result for every client, so confirm spans link to their send spans.
export const hashspan = withHashspan({
  agent: { name: 'treasury-agent' },
  recordFunctionArguments: true,
});

/** The chain the demo runs on: traced clients, the accounts it pays and withdraws from, and its amounts. */
export interface DemoChain {
  wallet: Pick<WalletClient<Transport, Chain, Account>, 'sendTransaction' | 'writeContract'>;
  reader: Pick<PublicClient<Transport, Chain>, 'waitForTransactionReceipt'>;
  vendor: Address;
  vault: Address;
  payEth: string;
  withdrawEth: string;
}

/** Anvil's first test account; Anvil signs for it, so no private key is needed here. */
const TREASURY: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const VENDOR: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const LOCAL_VAULT: Address = '0x00000000000000000000000000000000000000aa';

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

/** Runtime bytecode of a demo vault that rejects every withdrawal with `WithdrawalLimitExceeded(limit, requested)`. */
export function vaultCode(limit: bigint, requested: bigint): Hex {
  return revertingWith(
    encodeErrorResult({
      abi: vaultAbi,
      errorName: 'WithdrawalLimitExceeded',
      args: [limit, requested],
    }),
  );
}

/** Creation bytecode that deploys `runtime` (at most 255 bytes) as the contract's code. */
export function deployCode(runtime: Hex): Hex {
  const size = (runtime.length - 2) / 2;
  if (size > 0xff) throw new Error('runtime code too long');
  const length = size.toString(16).padStart(2, '0');
  // PUSH1 size, DUP1, PUSH1 11, PUSH1 0, CODECOPY, PUSH1 0, RETURN: copies the code after these 11 bytes and returns it.
  return `0x60${length}80600b6000396000f3${runtime.slice(2)}`;
}

/**
 * The local Anvil chain at `RPC_URL`, with a demo vault installed by `anvil_setCode`, so the demo can show a
 * reverted transaction and its decoded reason.
 */
export async function localChain(): Promise<DemoChain> {
  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const wallet = createWalletClient({
    account: TREASURY,
    chain: anvil,
    transport: http(rpcUrl),
    // Anvil mines instantly; viem would otherwise poll for receipts every 4 s.
    pollingInterval: 250,
  }).extend(hashspan);
  const reader = createPublicClient({
    chain: anvil,
    transport: http(rpcUrl),
    pollingInterval: 250,
  }).extend(hashspan);

  await reader.request({
    method: 'anvil_setCode' as never,
    params: [LOCAL_VAULT, vaultCode(10n ** 17n, 10n ** 18n)] as never,
  });
  return { wallet, reader, vendor: VENDOR, vault: LOCAL_VAULT, payEth: '0.25', withdrawEth: '1' };
}
