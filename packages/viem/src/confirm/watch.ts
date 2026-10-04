// `watch()`: confirming a transaction sent outside the extended clients.
import { diag } from '@opentelemetry/api';
import type { Abi, TransactionReceipt } from 'viem';
import { errorName } from '../safe-tracker.js';
import type { ViemClientLike, WatchOptions } from '../types.js';
import { type Confirmation, DEFAULT_BACKGROUND_TIMEOUT_MS } from './confirmation.js';
import { confirmKey, type Recent } from './recent.js';
import { chainIdOfClient, durationOr, isChainId, within } from './timing.js';

export interface WatchDependencies {
  abis: Recent<Abi>;
  confirmThrough: Confirmation['confirmThrough'];
  track(work: Promise<void>): void;
}

export function createWatch({
  abis,
  confirmThrough,
  track,
}: WatchDependencies): (client: ViemClientLike, options: WatchOptions) => void {
  const watch = (client: ViemClientLike, options: WatchOptions): void => {
    let called = false;
    /** Calls the caller's `onReceipt` once, never throwing into the watch. */
    const onReceipt = (receipt: TransactionReceipt | undefined): void => {
      if (called) return;
      called = true;
      try {
        const callback: unknown = options.onReceipt;
        if (typeof callback === 'function') callback(receipt);
      } catch (error) {
        diag.error(`hashspan: the onReceipt callback of watch() failed (${errorName(error)})`);
      }
    };
    try {
      const clientChain: unknown = client.chain?.id;
      const chainId: unknown = options.chainId ?? clientChain;
      // A chain id is a positive safe integer (ADR 0025 rule 3): no span is recorded with another one.
      if (!isChainId(chainId)) {
        diag.debug(
          'hashspan: watch() needs a valid chain id or a client with a valid chain; not recording it',
        );
        onReceipt(undefined);
        return;
      }
      const timeoutMs = durationOr(options.timeoutMs, DEFAULT_BACKGROUND_TIMEOUT_MS);
      /** Polling another chain would only end in a timeout, or a receipt recorded for the wrong chain. */
      const confirmOn = (clientChainId: number | undefined): void => {
        if (clientChainId !== chainId) {
          if (clientChainId !== undefined) {
            diag.warn(
              `hashspan: watch() got chain ${chainId} and a client on chain ${clientChainId}; not recording it`,
            );
          }
          onReceipt(undefined);
          return;
        }
        if (options.abi) abis.set(confirmKey(chainId, options.hash), options.abi);
        if (!confirmThrough(client, chainId, options.hash, timeoutMs, onReceipt))
          onReceipt(undefined);
      };
      if (clientChain !== undefined) {
        if (!isChainId(clientChain)) {
          diag.debug('hashspan: watch() got a client whose chain id is not one; not recording it');
          onReceipt(undefined);
          return;
        }
        confirmOn(clientChain);
        return;
      }
      // A client without a chain can be on any chain, and the chain id asked for can come from elsewhere, such as
      // the server of an x402 payment: ask the client, within the watch's timeout.
      track(
        within(chainIdOfClient(client), timeoutMs, 'ask a client for its chain id').then(confirmOn),
      );
    } catch (error) {
      diag.error(`hashspan: failed to watch a transaction (${errorName(error)})`);
      onReceipt(undefined);
    }
  };

  return watch;
}
