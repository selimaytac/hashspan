// The methods of `cdp.evm`: its transaction and user operation sends, waits, account factories and swap quotes.
import type { ChainIdFor } from './chain.js';
import { addressOf } from './helpers.js';
import { own } from './own.js';
import type { ServerAccountWrapping } from './server-account.js';
import type { SmartAccountWrapping } from './smart-account.js';
import { describeTransaction, type TransactionSpans } from './transaction-spans.js';
import type { UserOperationSpans } from './user-operation-spans.js';
import { replace, wrapFailed } from './wrap.js';

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

/** What wrapping `cdp.evm` needs from the `withHashspan()` call. */
export interface EvmWrappingDependencies
  extends ServerAccountWrapping,
    SmartAccountWrapping,
    Pick<TransactionSpans, 'traced'>,
    Pick<UserOperationSpans, 'tracedUserOperation' | 'confirmedUserOperation'> {
  chainIdFor: ChainIdFor;
}

/** Wraps the methods of `cdp.evm` in place, in the order `withHashspan()` always used. */
export function wrapEvm(
  evm: Record<string, unknown>,
  {
    chainIdFor,
    traced,
    tracedUserOperation,
    confirmedUserOperation,
    wrapAccount,
    wrapQuote,
    wrapSmartAccount,
    wrapUserOperationQuote,
    describeUserOperation,
  }: EvmWrappingDependencies,
): void {
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
}
