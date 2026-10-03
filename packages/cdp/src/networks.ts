/**
 * EIP-155 chain ids of the network names the CDP SDK accepts for EVM sends and user operations. The SDK has such a
 * map but does not export it. BNB Smart Chain has two names: `binance` for transactions, `bnb` for user operations.
 */
export const CDP_NETWORK_CHAIN_IDS: Readonly<Record<string, number>> = {
  base: 8453,
  'base-sepolia': 84532,
  ethereum: 1,
  'ethereum-sepolia': 11155111,
  polygon: 137,
  arbitrum: 42161,
  'arbitrum-sepolia': 421614,
  optimism: 10,
  'optimism-sepolia': 11155420,
  avalanche: 43114,
  world: 480,
  'world-sepolia': 4801,
  'ethereum-hoodi': 560048,
  'polygon-mumbai': 80001,
  binance: 56,
  bnb: 56,
  zora: 7777777,
};

/**
 * Chains on which a network-scoped account (`account.useNetwork(...)`) sends through the CDP API, that is through the
 * account's own `sendTransaction` / `transfer`. On other chains it sends through an internal viem client.
 */
export const CDP_API_SEND_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 84532, 1, 11155111]);

/**
 * The chain id of a CDP network name; undefined for a name the map does not have, including names of `Object.prototype`
 * members such as `constructor`, which a plain lookup would find.
 */
export function chainIdOf(network: unknown): number | undefined {
  if (typeof network !== 'string' || !Object.hasOwn(CDP_NETWORK_CHAIN_IDS, network))
    return undefined;
  const chainId = CDP_NETWORK_CHAIN_IDS[network];
  return typeof chainId === 'number' ? chainId : undefined;
}
