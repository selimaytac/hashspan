import * as chains from 'viem/chains';
import { expect, it } from 'vitest';
import { CDP_NETWORK_CHAIN_IDS } from '../src/index.js';

// The SDK's own name map is not a reliable source (it gives ethereum-hoodi the Holesky id), so the chain ids are
// checked against viem's chain definitions.
it('maps CDP network names to the chain ids of viem chains', () => {
  expect(CDP_NETWORK_CHAIN_IDS).toEqual({
    base: chains.base.id,
    'base-sepolia': chains.baseSepolia.id,
    ethereum: chains.mainnet.id,
    'ethereum-sepolia': chains.sepolia.id,
    'ethereum-hoodi': chains.hoodi.id,
    polygon: chains.polygon.id,
    'polygon-mumbai': chains.polygonMumbai.id,
    arbitrum: chains.arbitrum.id,
    'arbitrum-sepolia': chains.arbitrumSepolia.id,
    optimism: chains.optimism.id,
    'optimism-sepolia': chains.optimismSepolia.id,
    avalanche: chains.avalanche.id,
    binance: chains.bsc.id,
    bnb: chains.bsc.id,
    world: chains.worldchain.id,
    'world-sepolia': chains.worldchainSepolia.id,
    zora: chains.zora.id,
  });
});
