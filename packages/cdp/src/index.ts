import { createTxTracker, type TxTracker } from '@hashspan/core';
import {
  type FlushOptions,
  type ViemClientLike,
  type WithHashspanOptions as ViemOptions,
  withHashspan as withViemHashspan,
} from '@hashspan/viem';
import { diag } from '@opentelemetry/api';
import { createChainIdFor, createReaderFor } from './chain.js';
import { wrapEvm } from './evm.js';
import { createPending } from './pending.js';
import { createServerAccountWrapping } from './server-account.js';
import { createSmartAccountWrapping } from './smart-account.js';
import { createTransactionSpans } from './transaction-spans.js';
import { createUserOperationSpans } from './user-operation-spans.js';
import { WRAPPED } from './wrap.js';

export { CDP_NETWORK_CHAIN_IDS } from './networks.js';

export interface WithHashspanCdpOptions extends Omit<ViemOptions, 'confirm'> {
  /**
   * viem public client(s) to confirm transactions with, and to read the outcome of user operations from their bundle
   * receipts: one client, used for every chain it is on, or a function returning the client for a chain id. Without
   * a reader, only send spans are recorded, except for the waits the SDK offers (network-scoped
   * `waitForTransactionReceipt` and `waitForUserOperation`); the adapter never chooses an RPC endpoint itself.
   */
  reader?: ViemClientLike | ((chainId: number) => ViemClientLike | undefined) | undefined;
  /**
   * How long to poll for a receipt before the confirm span ends as `timeout`; for a user operation that CDP reported
   * complete, how long to poll for its bundle receipt before the span ends with the bundle's hash only. Default:
   * 120 000 ms.
   */
  confirmTimeoutMs?: number | undefined;
}

/** Returned by {@link withHashspan}; the CDP client itself is wrapped in place. */
export interface HashspanCdp {
  /**
   * Waits for tracing work still running after traced calls returned (background confirmations through the reader,
   * waits of network-scoped accounts and `waitForUserOperation` waits), so their spans are ended before the OpenTelemetry SDK shuts down. Resolves
   * true when all of it finished, false on timeout (default 10 000 ms), ending confirm spans still open as `timeout`
   * (a user operation CDP reported complete ends with what is known); never rejects. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.9.1/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
}

// Structural views of the CDP SDK objects, so that the adapter does not depend on its internal types.
interface CdpClientLike {
  // `object`, not a record type: the SDK's `EvmClient` class has no index signature.
  evm: object;
}
// The same default as @hashspan/viem's flush().
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Traces transactions sent by a Coinbase CDP client's EVM server accounts, and user operations of its smart accounts,
 * with `@hashspan/core` (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.9.1/docs/adr/0012-cdp-adapter.md,
 * https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.9.1/docs/adr/0021-user-operations.md). It wraps the
 * client in place: `cdp.evm.sendTransaction`, its user operation methods and `waitForUserOperation`, the account and
 * smart account factories, and the send methods of every account they return. Call
 * it once, right after creating the client: a second call on the same client returns the first handle, ignores its
 * options and logs a `diag` warning. Never throws into the traced calls; transactions on networks it cannot map to a
 * chain id are sent untraced, with a warning.
 */
export function withHashspan(
  cdp: CdpClientLike,
  options: WithHashspanCdpOptions = {},
): HashspanCdp {
  const { reader, confirmTimeoutMs, tracker: providedTracker, ...rest } = options;
  const tracker: TxTracker = providedTracker ?? createTxTracker(rest);
  // Confirmations reuse the viem adapter's receipt handling, on the same tracker.
  const viem = withViemHashspan({ ...rest, tracker });

  const chainIdFor = createChainIdFor();
  const { track, waiting, flushOwn } = createPending();
  const readerFor = createReaderFor({ reader });

  const { traced, confirmed } = createTransactionSpans({
    tracker,
    viem,
    readerFor,
    track,
    waiting,
    confirmTimeoutMs,
  });
  const { tracedUserOperation, confirmedUserOperation } = createUserOperationSpans({
    tracker,
    readerFor,
    track,
    waiting,
    confirmTimeoutMs,
  });

  const { wrapAccount, wrapQuote } = createServerAccountWrapping({ chainIdFor, traced, confirmed });
  const { describeUserOperation, wrapUserOperationQuote, wrapSmartAccount } =
    createSmartAccountWrapping({ chainIdFor, tracedUserOperation, confirmedUserOperation });

  const handle: HashspanCdp = {
    flush: async (flushOptions) => {
      const timeoutMs = flushOptions?.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
      const [viemDone, ownDone] = await Promise.all([
        viem.flush({ timeoutMs }),
        flushOwn(timeoutMs),
      ]);
      return viemDone && ownDone;
    },
  };
  let evm: Record<string, unknown> & { [WRAPPED]?: HashspanCdp };
  try {
    evm = cdp.evm as typeof evm;
    const existing = evm[WRAPPED];
    if (existing) {
      diag.warn(
        'hashspan: this CDP client is already traced; ignoring the options of the second withHashspan()',
      );
      return existing;
    }
    Object.defineProperty(evm, WRAPPED, { value: handle });
  } catch {
    // A client that cannot be read or marked is not traced; withHashspan() never throws into the caller (ADR 0025).
    diag.warn('hashspan: not tracing this CDP client: it cannot be read or marked as traced');
    return handle;
  }
  wrapEvm(evm, {
    chainIdFor,
    traced,
    tracedUserOperation,
    confirmedUserOperation,
    wrapAccount,
    wrapQuote,
    wrapSmartAccount,
    wrapUserOperationQuote,
    describeUserOperation,
  });

  return handle;
}
