import {
  createTxTracker,
  type SendInput,
  type TxTracker,
  type UserOperationInput,
} from '@hashspan/core';
import {
  type FlushOptions,
  type ViemClientLike,
  type WithHashspanOptions as ViemOptions,
  withHashspan as withViemHashspan,
} from '@hashspan/viem';
import { diag } from '@opentelemetry/api';
import { createChainIdFor, createReaderFor } from './chain.js';
import { addressOf, isHexString } from './helpers.js';
import { CDP_API_SEND_CHAIN_IDS } from './networks.js';
import { own } from './own.js';
import { createPending } from './pending.js';
import { createTransactionSpans, describeTransaction } from './transaction-spans.js';
import { createUserOperationSpans } from './user-operation-spans.js';
import { type AccountLike, type AnyFn, replace, WRAPPED, wrapFailed } from './wrap.js';

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
const TRANSFER_SELECTOR = '0xa9059cbb';
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

  /** Wraps a network-scoped account in place; never throws, so a call that returned it never fails. */
  const wrapScopedAccount = (scoped: unknown): unknown => {
    if (scoped === null || typeof scoped !== 'object') return scoped;
    const account = scoped as AccountLike;
    let chainId: number | undefined;
    try {
      chainId = chainIdFor(own(account, 'network'));
    } catch (error) {
      wrapFailed(error);
    }
    if (chainId === undefined) return scoped;
    const id = chainId;
    replace(
      account,
      'waitForTransactionReceipt',
      (original) =>
        async (...args: never[]) =>
          confirmed(id, args[0], () => original(...args)),
    );
    // Through the CDP API, the scoped methods call the wrapped account's own methods, which trace the call.
    if (CDP_API_SEND_CHAIN_IDS.has(id)) return scoped;
    replace(account, 'sendTransaction', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [{ transaction?: unknown } | undefined];
      return traced(
        () => id,
        () => ({ from: addressOf(account), ...describeTransaction(own(opts, 'transaction')) }),
        () => original(...args),
      );
    });
    replace(account, 'transfer', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [Record<string, unknown> | undefined];
      return traced(
        () => id,
        () => describeTransfer(account, opts),
        () => original(...args),
      );
    });
    return scoped;
  };

  const describeTransfer = (
    account: AccountLike,
    opts: Record<string, unknown> | undefined,
  ): Omit<SendInput, 'chainId'> => {
    const recipient = addressOf(own(opts, 'to'));
    const given = own(opts, 'amount');
    const amount = typeof given === 'bigint' ? given : undefined;
    const token = own(opts, 'token');
    if (token === 'eth') return { from: addressOf(account), to: recipient, value: amount };
    // An ERC-20 transfer: the transaction goes to the token contract.
    return {
      from: addressOf(account),
      to: isHexString(token) ? token : undefined,
      functionName: 'transfer',
      functionSelector: TRANSFER_SELECTOR,
      functionArguments:
        recipient !== undefined && amount !== undefined ? [recipient, amount] : undefined,
    };
  };

  /** Traces `quote.execute()`, which sends the swap of an account (not of a smart account, which sends a user operation). */
  const wrapQuote = (value: unknown, from: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const quote = value as Record<string, unknown>;
    replace(
      quote,
      'execute',
      (original) =>
        async (...args: never[]) =>
          traced(
            () => chainIdFor(own(quote, 'network')),
            () => ({ from: addressOf(from) }),
            () => original(...args),
          ),
    );
    return value;
  };

  /**
   * Wraps an account in place; never throws, so a call that returned it never fails. The account is marked as wrapped
   * only once every method was replaced; wrapping it again replaces only the methods still missing.
   */
  const wrapAccount = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const account = value as AccountLike & { [WRAPPED]?: true };
    try {
      if (account[WRAPPED]) return value;
    } catch (error) {
      wrapFailed(error);
      return value;
    }

    const replaced = [
      replace(account, 'sendTransaction', (original) => async (...args: never[]) => {
        const [opts] = args as unknown as [
          { network?: unknown; transaction?: unknown } | undefined,
        ];
        return traced(
          () => chainIdFor(own(opts, 'network')),
          () => ({ from: addressOf(account), ...describeTransaction(own(opts, 'transaction')) }),
          () => original(...args),
        );
      }),
      replace(account, 'transfer', (original) => async (...args: never[]) => {
        const [opts] = args as unknown as [Record<string, unknown> | undefined];
        return traced(
          () => chainIdFor(own(opts, 'network')),
          () => describeTransfer(account, opts),
          () => original(...args),
        );
      }),
      replace(account, 'swap', (original) => async (...args: never[]) => {
        const [opts] = args as unknown as [
          { network?: unknown; swapQuote?: { network?: unknown } } | undefined,
        ];
        return traced(
          () => chainIdFor(own(opts, 'network') ?? own(own(opts, 'swapQuote'), 'network')),
          () => ({ from: addressOf(account) }),
          () => original(...args),
        );
      }),
      replace(
        account,
        'quoteSwap',
        (original) =>
          async (...args: never[]) =>
            wrapQuote(await original(...args), account),
      ),
      replace(account, 'useSpendPermission', (original) => async (...args: never[]) => {
        const [opts] = args as unknown as [{ network?: unknown; value?: unknown } | undefined];
        return traced(
          () => chainIdFor(own(opts, 'network')),
          () => ({ from: addressOf(account) }),
          () => original(...args),
        );
      }),
      replace(
        account,
        'useNetwork',
        (original) =>
          async (...args: never[]) =>
            wrapScopedAccount(await original(...args)),
      ),
    ];
    if (replaced.every(Boolean)) {
      try {
        Object.defineProperty(account, WRAPPED, { value: true });
      } catch (error) {
        wrapFailed(error);
      }
    }
    return value;
  };

  /** What the send span of a call with `calls` records: the sender, and the number of calls if they are an own array. */
  const describeUserOperation = (
    smartAccount: unknown,
    calls: unknown,
  ): Omit<UserOperationInput, 'chainId'> => {
    const count = Array.isArray(calls) ? own(calls, 'length') : undefined;
    return {
      sender: addressOf(smartAccount),
      callCount: typeof count === 'number' ? count : undefined,
    };
  };

  /** Traces `quote.execute()` of a quote created for a smart account, which sends a user operation. */
  const wrapUserOperationQuote = (value: unknown, smartAccount: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const quote = value as Record<string, unknown>;
    replace(
      quote,
      'execute',
      (original) =>
        async (...args: never[]) =>
          tracedUserOperation(
            () => chainIdFor(own(quote, 'network')),
            () => ({ sender: addressOf(smartAccount) }),
            () => original(...args),
          ),
    );
    return value;
  };

  /**
   * Wraps a network-scoped smart account in place; never throws. Its `useSpendPermission` calls the wrapped smart
   * account's, which traces it; its other send methods call the SDK's functions directly, so they are wrapped here.
   */
  const wrapScopedSmartAccount = (scoped: unknown): unknown => {
    if (scoped === null || typeof scoped !== 'object') return scoped;
    const account = scoped as AccountLike;
    let chainId: number | undefined;
    try {
      chainId = chainIdFor(own(account, 'network'));
    } catch (error) {
      wrapFailed(error);
    }
    if (chainId === undefined) return scoped;
    const id = chainId;
    replace(account, 'sendUserOperation', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [Record<string, unknown> | undefined];
      return tracedUserOperation(
        () => id,
        () => describeUserOperation(account, own(opts, 'calls')),
        () => original(...args),
      );
    });
    replace(
      account,
      'transfer',
      (original) =>
        async (...args: never[]) =>
          tracedUserOperation(
            () => id,
            () => ({ sender: addressOf(account) }),
            () => original(...args),
          ),
    );
    replace(account, 'swap', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [Record<string, unknown> | undefined];
      return tracedUserOperation(
        // A quote-based swap is sent on the quote's network, as it is passed on unchanged.
        () => {
          const quote = own(opts, 'swapQuote');
          return quote === undefined ? id : chainIdFor(own(quote, 'network'));
        },
        () => ({ sender: addressOf(account) }),
        () => original(...args),
      );
    });
    replace(
      account,
      'quoteSwap',
      (original) =>
        async (...args: never[]) =>
          wrapUserOperationQuote(await original(...args), account),
    );
    replace(
      account,
      'waitForUserOperation',
      (original) =>
        async (...args: never[]) =>
          confirmedUserOperation(
            id,
            () => addressOf(account),
            args[0],
            () => original(...args),
          ),
    );
    return scoped;
  };

  /**
   * Wraps a smart account in place, like {@link wrapAccount}: never throws, and marks the account only once every
   * method was replaced. Each send method calls the SDK's `sendUserOperation` function directly, not the account's
   * method, so each is wrapped and traced once.
   */
  const wrapSmartAccount = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const account = value as AccountLike & { [WRAPPED]?: true };
    try {
      if (account[WRAPPED]) return value;
    } catch (error) {
      wrapFailed(error);
      return value;
    }
    const sendOn =
      (
        describe: (
          opts: Record<string, unknown> | undefined,
        ) => Omit<UserOperationInput, 'chainId'>,
      ) =>
      (original: AnyFn) =>
      async (...args: never[]) => {
        const [opts] = args as unknown as [Record<string, unknown> | undefined];
        return tracedUserOperation(
          () => chainIdFor(own(opts, 'network')),
          () => describe(opts),
          () => original(...args),
        );
      };
    const sender = () => ({ sender: addressOf(account) });
    const replaced = [
      replace(
        account,
        'sendUserOperation',
        sendOn((opts) => describeUserOperation(account, own(opts, 'calls'))),
      ),
      replace(account, 'transfer', sendOn(sender)),
      replace(account, 'useSpendPermission', sendOn(sender)),
      replace(account, 'swap', (original) => async (...args: never[]) => {
        const [opts] = args as unknown as [Record<string, unknown> | undefined];
        return tracedUserOperation(
          () => chainIdFor(own(opts, 'network') ?? own(own(opts, 'swapQuote'), 'network')),
          sender,
          () => original(...args),
        );
      }),
      replace(
        account,
        'quoteSwap',
        (original) =>
          async (...args: never[]) =>
            wrapUserOperationQuote(await original(...args), account),
      ),
      replace(
        account,
        'waitForUserOperation',
        (original) =>
          async (...args: never[]) =>
            confirmedUserOperation(
              undefined,
              () => addressOf(account),
              args[0],
              () => original(...args),
            ),
      ),
      replace(
        account,
        'useNetwork',
        (original) =>
          async (...args: never[]) =>
            wrapScopedSmartAccount(await original(...args)),
      ),
    ];
    if (replaced.every(Boolean)) {
      try {
        Object.defineProperty(account, WRAPPED, { value: true });
      } catch (error) {
        wrapFailed(error);
      }
    }
    return value;
  };

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
