// The reader's own values in readme/watch-user-operation.ts, which user-operation.int.test.ts sets before it runs that
// block against Anvil: a chain and its RPC URL, a bundler client, and the hashes a wallet returned.
import type { Address, Chain, Hex } from 'viem';
import type { BundlerClient } from 'viem/account-abstraction';

export let chain: Chain;
export let rpcUrl: string;
export let bundler: BundlerClient;
/** The bundle transaction's hash a wallet or a smart account SDK returned. */
export let hash: Hex;
/** The smart account that sent the operation. */
export let smartAccountAddress: Address;
/** The user operation hash, when a wallet returned that instead. */
export let userOpHash: Hex;

export function setUp(values: {
  chain: Chain;
  rpcUrl: string;
  bundler: BundlerClient;
  hash: Hex;
  smartAccountAddress: Address;
  userOpHash: Hex;
}): void {
  ({ chain, rpcUrl, bundler, hash, smartAccountAddress, userOpHash } = values);
}
