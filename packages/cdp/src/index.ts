import { createTxTracker, type TxTracker } from '@hashspan/core';
import {
  type FlushOptions,
  type ViemClientLike,
  type WithHashspanOptions as ViemOptions,
  withHashspan as withViemHashspan,
} from '@hashspan/viem';
import { diag } from '@opentelemetry/api';
import { createChainIdFor, createReaderFor } from './chain.js';
import { addressOf } from './helpers.js';
import { own } from './own.js';
import { createPending } from './pending.js';
import { createServerAccountWrapping } from './server-account.js';
import { createSmartAccountWrapping } from './smart-account.js';
import { createTransactionSpans, describeTransaction } from './transaction-spans.js';
import { createUserOperationSpans } from './user-operation-spans.js';
import { replace, WRAPPED, wrapFailed } from './wrap.js';

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
const ACCOUNT_FACTORIES = [
  'createAccount',
  'getAccount',
  'getOrCreateAccount',
  'importAccount',
  'updateAccount',
] as const;
// `listSmartAccounts` is not among them: it returns plain records without methods.
const SMART_ACCOUNT_FACTORIES = [
  'createSmartAccount',
  'getSmartAccount',
  'getOrCreateSmartAccount',
  'updateSmartAccount',
] as const;

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
  const evm = cdp.evm as Record<string, unknown> & { [WRAPPED]?: HashspanCdp };
  const existing = evm[WRAPPED];
  if (existing) {
    diag.warn(
      'hashspan: this CDP client is already traced; ignoring the options of the second withHashspan()',
    );
    return existing;
  }
  Object.defineProperty(evm, WRAPPED, { value: handle });
  replace(evm, 'sendTransaction', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [
      { address?: unknown; network?: unknown; transaction?: unknown } | undefined,
    ];
    return traced(
      () => chainIdFor(own(opts, 'network')),
      () => ({
        from: addressOf(own(opts, 'address')),
        ...describeTransaction(own(opts, 'transaction')),
      }),
      () => original(...args),
    );
  });
  for (const factory of ACCOUNT_FACTORIES) {
    replace(
      evm,
      factory,
      (original) =>
        async (...args: never[]) =>
          wrapAccount(await original(...args)),
    );
  }
  for (const factory of SMART_ACCOUNT_FACTORIES) {
    replace(
      evm,
      factory,
      (original) =>
        async (...args: never[]) =>
          wrapSmartAccount(await original(...args)),
    );
  }
  replace(evm, 'createSwapQuote', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [{ taker?: unknown; smartAccount?: unknown } | undefined];
    const quote = await original(...args);
    try {
      const smartAccount = opts ? Object.getOwnPropertyDescriptor(opts, 'smartAccount') : undefined;
      if (smartAccount === undefined) return wrapQuote(quote, own(opts, 'taker'));
      // A smart account given through a getter still makes a user operation quote, which is left untraced: its
      // sender cannot be read without running the getter.
      if (!('value' in smartAccount)) return quote;
      return smartAccount.value === undefined
        ? wrapQuote(quote, own(opts, 'taker'))
        : wrapUserOperationQuote(quote, smartAccount.value);
    } catch (error) {
      wrapFailed(error);
      return quote;
    }
  });
  // Each calls the SDK's `sendUserOperation` function, or the CDP API, directly: none goes through another.
  replace(evm, 'sendUserOperation', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [Record<string, unknown> | undefined];
    return tracedUserOperation(
      () => chainIdFor(own(opts, 'network')),
      () => describeUserOperation(own(opts, 'smartAccount'), own(opts, 'calls')),
      () => original(...args),
    );
  });
  replace(evm, 'prepareAndSendUserOperation', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [Record<string, unknown> | undefined];
    return tracedUserOperation(
      () => chainIdFor(own(opts, 'network')),
      () => describeUserOperation(own(opts, 'smartAccount'), own(opts, 'calls')),
      () => original(...args),
    );
  });
  replace(evm, 'createSpendPermission', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [Record<string, unknown> | undefined];
    return tracedUserOperation(
      () => chainIdFor(own(opts, 'network')),
      () => ({ sender: addressOf(own(own(opts, 'spendPermission'), 'account')) }),
      () => original(...args),
    );
  });
  replace(evm, 'revokeSpendPermission', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [Record<string, unknown> | undefined];
    return tracedUserOperation(
      () => chainIdFor(own(opts, 'network')),
      () => ({ sender: addressOf(own(opts, 'address')) }),
      () => original(...args),
    );
  });
  replace(evm, 'waitForUserOperation', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [Record<string, unknown> | undefined];
    return confirmedUserOperation(
      undefined,
      () => own(opts, 'smartAccountAddress'),
      opts,
      () => original(...args),
    );
  });
  replace(evm, 'listAccounts', (original) => async (...args: never[]) => {
    const result = (await original(...args)) as { accounts?: unknown[] } | undefined;
    try {
      // Each account is wrapped on its own: one that cannot be wrapped leaves the others traced.
      if (Array.isArray(result?.accounts)) result.accounts.forEach(wrapAccount);
    } catch (error) {
      wrapFailed(error);
    }
    return result;
  });

  return handle;
}
