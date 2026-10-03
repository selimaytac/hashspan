// Which chain a call is on, from its CDP network name, and the reader for that chain.
import type { ViemClientLike } from '@hashspan/viem';
import { diag } from '@opentelemetry/api';
import { errorName } from './helpers.js';
import { chainIdOf } from './networks.js';

// Unknown network values are named in warnings only when they look like a network name, never an RPC URL.
const NETWORK_NAME = /^[a-z0-9-]{1,32}$/;
const MAX_WARNED_NETWORKS = 32;

/** The chain id of a CDP network name, from {@link createChainIdFor}. */
export type ChainIdFor = (network: unknown) => number | undefined;

/** The reader for a chain id, from {@link createReaderFor}. */
export type ReaderFor = (chainId: number) => ViemClientLike | undefined;

/** The `reader` option of `withHashspan()`. */
export type Reader = ViemClientLike | ((chainId: number) => ViemClientLike | undefined) | undefined;

/** One per `withHashspan()` call, so that each call warns once per unknown network name. */
export function createChainIdFor(): ChainIdFor {
  const warnedNetworks = new Set<string>();
  /** The chain id of a CDP network name; warns once per unknown name, without recording RPC URLs or other values. */
  const chainIdFor = (network: unknown): number | undefined => {
    const chainId = chainIdOf(network);
    if (chainId !== undefined || network === undefined) return chainId;
    const name = typeof network === 'string' && NETWORK_NAME.test(network) ? network : undefined;
    const key = name ?? '';
    if (!warnedNetworks.has(key) && warnedNetworks.size < MAX_WARNED_NETWORKS) {
      warnedNetworks.add(key);
      diag.warn(
        `hashspan: not tracing calls on ${name === undefined ? 'an RPC URL or unknown network' : `the unknown CDP network "${name}"`}`,
      );
    }
    return undefined;
  };
  return chainIdFor;
}

export function createReaderFor({ reader }: { reader: Reader }): ReaderFor {
  const readerFor = (chainId: number): ViemClientLike | undefined => {
    try {
      const client = typeof reader === 'function' ? reader(chainId) : reader;
      if (client && (client.chain?.id === undefined || client.chain.id === chainId)) return client;
      if (client) {
        diag.warn(
          `hashspan: the reader is on chain ${client.chain?.id}, not ${chainId}; not confirming the transaction`,
        );
      }
    } catch (error) {
      diag.error(`hashspan: the reader function failed (${errorName(error)})`);
    }
    return undefined;
  };
  return readerFor;
}
