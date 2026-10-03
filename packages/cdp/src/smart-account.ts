// Smart accounts and their network-scoped accounts, wrapped in place (ADR 0021), and the swap quotes they create.
import type { UserOperationInput } from '@hashspan/core';
import type { ChainIdFor } from './chain.js';
import { addressOf } from './helpers.js';
import { own } from './own.js';
import type { UserOperationSpans } from './user-operation-spans.js';
import { type AccountLike, type AnyFn, replace, WRAPPED, wrapFailed } from './wrap.js';

/** What wrapping smart accounts needs from the `withHashspan()` call. */
export interface SmartAccountWrappingDependencies {
  chainIdFor: ChainIdFor;
  tracedUserOperation: UserOperationSpans['tracedUserOperation'];
  confirmedUserOperation: UserOperationSpans['confirmedUserOperation'];
}

export interface SmartAccountWrapping {
  /** What the send span of a call with `calls` records. */
  describeUserOperation(smartAccount: unknown, calls: unknown): Omit<UserOperationInput, 'chainId'>;
  /** Traces `quote.execute()` of a quote created for a smart account. */
  wrapUserOperationQuote(value: unknown, smartAccount: unknown): unknown;
  /** Wraps a smart account in place; never throws. */
  wrapSmartAccount(value: unknown): unknown;
}

export function createSmartAccountWrapping({
  chainIdFor,
  tracedUserOperation,
  confirmedUserOperation,
}: SmartAccountWrappingDependencies): SmartAccountWrapping {
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

  return { describeUserOperation, wrapUserOperationQuote, wrapSmartAccount };
}
