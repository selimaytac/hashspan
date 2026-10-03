// Server accounts and their network-scoped accounts, wrapped in place (ADR 0012), and the swap quotes they create.
import type { SendInput } from '@hashspan/core';
import type { ChainIdFor } from './chain.js';
import { addressOf, isHexString } from './helpers.js';
import { CDP_API_SEND_CHAIN_IDS } from './networks.js';
import { own } from './own.js';
import { describeTransaction, type TransactionSpans } from './transaction-spans.js';
import { type AccountLike, replace, WRAPPED, wrapFailed } from './wrap.js';

const TRANSFER_SELECTOR = '0xa9059cbb';

/** What wrapping server accounts needs from the `withHashspan()` call. */
export interface ServerAccountWrappingDependencies {
  chainIdFor: ChainIdFor;
  traced: TransactionSpans['traced'];
  confirmed: TransactionSpans['confirmed'];
}

export interface ServerAccountWrapping {
  /** Wraps an account in place; never throws. */
  wrapAccount(value: unknown): unknown;
  /** Traces `quote.execute()`, which sends the swap of an account. */
  wrapQuote(value: unknown, from: unknown): unknown;
}

export function createServerAccountWrapping({
  chainIdFor,
  traced,
  confirmed,
}: ServerAccountWrappingDependencies): ServerAccountWrapping {
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

  return { wrapAccount, wrapQuote };
}
