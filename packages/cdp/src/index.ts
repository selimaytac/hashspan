import { createTxTracker, type ReceiptLike, type SendInput, type TxTracker } from '@hashspan/core';
import {
  type FlushOptions,
  type ViemClientLike,
  type WithHashspanOptions as ViemOptions,
  withHashspan as withViemHashspan,
} from '@hashspan/viem';
import { diag } from '@opentelemetry/api';
import { parseTransaction } from 'viem';
import { CDP_API_SEND_CHAIN_IDS, chainIdOf } from './networks.js';

export { CDP_NETWORK_CHAIN_IDS } from './networks.js';

export interface WithHashspanCdpOptions extends Omit<ViemOptions, 'confirm'> {
  /**
   * viem public client(s) to confirm transactions with: one client, used for every chain it is on, or a function
   * returning the client for a chain id. Without a reader, only send spans are recorded; the adapter never chooses
   * an RPC endpoint itself.
   */
  reader?: ViemClientLike | ((chainId: number) => ViemClientLike | undefined) | undefined;
  /** How long to poll for a receipt before the confirm span ends as `timeout`. Default: 120 000 ms. */
  confirmTimeoutMs?: number | undefined;
}

/** Returned by {@link withHashspan}; the CDP client itself is wrapped in place. */
export interface HashspanCdp {
  /** Waits for pending confirmations before the OpenTelemetry SDK shuts down; see docs/adr/0010. */
  flush(options?: FlushOptions): Promise<boolean>;
}

// Structural views of the CDP SDK objects, so that the adapter does not depend on its internal types.
type AnyFn = (...args: never[]) => Promise<unknown>;
interface CdpClientLike {
  evm: Record<string, unknown>;
}
interface AccountLike {
  address?: unknown;
  [key: string]: unknown;
}
interface TransactionResultLike {
  transactionHash?: unknown;
}

const WRAPPED = Symbol.for('hashspan.cdp.wrapped');
const TRANSFER_SELECTOR = '0xa9059cbb';
// Unknown network values are named in warnings only when they look like a network name, never an RPC URL.
const NETWORK_NAME = /^[a-z0-9-]{1,32}$/;
const MAX_WARNED_NETWORKS = 32;
const ACCOUNT_FACTORIES = [
  'createAccount',
  'getAccount',
  'getOrCreateAccount',
  'importAccount',
  'updateAccount',
] as const;

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'unknown error';
}

/** The CDP API's error type (`APIError.errorType`, e.g. `insufficient_balance`), recorded as `error.type`. */
function cdpErrorType(error: unknown): string | undefined {
  const type = error instanceof Error ? (error as { errorType?: unknown }).errorType : undefined;
  return typeof type === 'string' ? type : undefined;
}

/** The fields of a viem receipt that the confirm span records, or undefined if `value` is not one. */
function receiptOf(value: unknown): ReceiptLike | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const receipt = value as Record<string, unknown>;
  const { status, blockNumber, gasUsed } = receipt;
  if (status !== 'success' && status !== 'reverted') return undefined;
  if (typeof blockNumber !== 'bigint' || typeof gasUsed !== 'bigint') return undefined;
  const optional = (v: unknown) => (typeof v === 'bigint' ? v : undefined);
  return {
    status,
    blockNumber,
    gasUsed,
    effectiveGasPrice: optional(receipt.effectiveGasPrice),
    l1Fee: optional(receipt.l1Fee),
    transactionHash:
      typeof receipt.transactionHash === 'string' ? receipt.transactionHash : undefined,
  };
}

function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function addressOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AccountLike).address === 'string'
  ) {
    return (value as { address: string }).address;
  }
  return undefined;
}

/** Transaction fields for the send span, from a request object or a serialized transaction. */
function describeTransaction(transaction: unknown): Omit<SendInput, 'chainId'> {
  let request: Record<string, unknown> | undefined;
  if (isHexString(transaction)) {
    try {
      request = parseTransaction(transaction) as Record<string, unknown>;
    } catch {
      diag.debug('hashspan: could not parse the serialized transaction');
    }
  } else if (transaction !== null && typeof transaction === 'object') {
    request = transaction as Record<string, unknown>;
  }
  if (!request) return {};
  const data = request.data;
  return {
    to: typeof request.to === 'string' ? request.to : undefined,
    value: typeof request.value === 'bigint' ? request.value : undefined,
    nonce: typeof request.nonce === 'number' ? request.nonce : undefined,
    functionSelector: typeof data === 'string' && data.length >= 10 ? data.slice(0, 10) : undefined,
  };
}

/**
 * Traces transactions sent by a Coinbase CDP client's EVM server accounts with `@hashspan/core`
 * (docs/adr/0012-cdp-adapter.md). It wraps the client in place: `cdp.evm.sendTransaction`, the account factories and
 * the send methods of every account they return. Call it once, right after creating the client.
 */
export function withHashspan(
  cdp: CdpClientLike,
  options: WithHashspanCdpOptions = {},
): HashspanCdp {
  const { reader, confirmTimeoutMs, tracker: providedTracker, ...rest } = options;
  const tracker: TxTracker = providedTracker ?? createTxTracker(rest);
  // Confirmations reuse the viem adapter's receipt handling, on the same tracker.
  const viem = withViemHashspan({ ...rest, tracker });

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

  /** Runs `send` inside a send span when the chain id is known; the result and errors are passed on unchanged. */
  const traced = async (
    chainId: number | undefined,
    describe: () => Omit<SendInput, 'chainId'>,
    send: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (chainId === undefined) {
      diag.debug('hashspan: no known CDP network in the call; not tracing it');
      return send();
    }
    let handle: ReturnType<TxTracker['startSend']> | undefined;
    try {
      handle = tracker.startSend({ ...describe(), chainId });
    } catch (error) {
      diag.error(`hashspan: failed to start send span (${errorName(error)})`);
    }
    let result: unknown;
    try {
      result = await send();
    } catch (error) {
      try {
        handle?.fail(error, undefined, { errorType: cdpErrorType(error) });
      } catch (thrown) {
        diag.error(`hashspan: failed to record send failure (${errorName(thrown)})`);
      }
      throw error;
    }
    try {
      const hash = (result as TransactionResultLike | undefined)?.transactionHash;
      if (typeof hash === 'string') {
        handle?.end(hash);
        const client = readerFor(chainId);
        if (client) viem.watch(client, { hash, chainId, timeoutMs: confirmTimeoutMs });
      } else {
        handle?.fail(new TypeError('no transactionHash in the CDP result'));
      }
    } catch (error) {
      diag.error(`hashspan: failed to record send span (${errorName(error)})`);
    }
    return result;
  };

  /**
   * Runs a network-scoped account's `waitForTransactionReceipt` inside a confirm span, for users without a reader.
   * With a reader, the background confirmation records the receipt with its revert reason, so the wait is passed on
   * untraced. The result and errors are passed on unchanged.
   */
  const confirmed = async (
    chainId: number,
    options: unknown,
    wait: () => Promise<unknown>,
  ): Promise<unknown> => {
    const opts = (options ?? {}) as { hash?: unknown; transactionHash?: unknown };
    const hash = typeof opts.hash === 'string' ? opts.hash : opts.transactionHash;
    if (typeof hash !== 'string' || readerFor(chainId)) return wait();
    let handle: ReturnType<TxTracker['startConfirm']> | undefined;
    try {
      handle = tracker.startConfirm({ chainId, hash });
    } catch (error) {
      diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
    }
    let result: unknown;
    try {
      result = await wait();
    } catch (error) {
      try {
        if (error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError') {
          handle?.timeout();
        } else {
          handle?.fail(error);
        }
      } catch (thrown) {
        diag.error(`hashspan: failed to record confirmation failure (${errorName(thrown)})`);
      }
      throw error;
    }
    try {
      const receipt = receiptOf(result);
      if (receipt) handle?.end(receipt);
      else handle?.fail(new TypeError('not a transaction receipt'));
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
    }
    return result;
  };

  /** Replaces `target[name]` with `wrap(original)`, calling the original with `target` as `this`. */
  const replace = (
    target: Record<string, unknown>,
    name: string,
    wrap: (original: AnyFn) => AnyFn,
  ): void => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = wrap((original as AnyFn).bind(target));
  };

  const wrapScopedAccount = (scoped: unknown): unknown => {
    if (scoped === null || typeof scoped !== 'object') return scoped;
    const account = scoped as AccountLike;
    const chainId = chainIdFor(account.network);
    if (chainId === undefined) return scoped;
    replace(
      account,
      'waitForTransactionReceipt',
      (original) =>
        async (...args: never[]) =>
          confirmed(chainId, args[0], () => original(...args)),
    );
    // Through the CDP API, the scoped methods call the wrapped account's own methods, which trace the call.
    if (CDP_API_SEND_CHAIN_IDS.has(chainId)) return scoped;
    replace(account, 'sendTransaction', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [{ transaction?: unknown } | undefined];
      return traced(
        chainId,
        () => ({ from: addressOf(account), ...describeTransaction(opts?.transaction) }),
        () => original(...args),
      );
    });
    replace(account, 'transfer', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [Record<string, unknown> | undefined];
      return traced(
        chainId,
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
    const recipient = addressOf(opts?.to);
    const amount = typeof opts?.amount === 'bigint' ? opts.amount : undefined;
    if (opts?.token === 'eth') return { from: addressOf(account), to: recipient, value: amount };
    // An ERC-20 transfer: the transaction goes to the token contract.
    return {
      from: addressOf(account),
      to: isHexString(opts?.token) ? opts.token : undefined,
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
            chainIdFor(quote.network),
            () => ({ from: addressOf(from) }),
            () => original(...args),
          ),
    );
    return value;
  };

  const wrapAccount = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const account = value as AccountLike & { [WRAPPED]?: true };
    if (account[WRAPPED]) return value;
    Object.defineProperty(account, WRAPPED, { value: true });

    replace(account, 'sendTransaction', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [{ network?: unknown; transaction?: unknown } | undefined];
      return traced(
        chainIdFor(opts?.network),
        () => ({ from: addressOf(account), ...describeTransaction(opts?.transaction) }),
        () => original(...args),
      );
    });
    replace(account, 'transfer', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [Record<string, unknown> | undefined];
      return traced(
        chainIdFor(opts?.network),
        () => describeTransfer(account, opts),
        () => original(...args),
      );
    });
    replace(account, 'swap', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [
        { network?: unknown; swapQuote?: { network?: unknown } } | undefined,
      ];
      return traced(
        chainIdFor(opts?.network ?? opts?.swapQuote?.network),
        () => ({ from: addressOf(account) }),
        () => original(...args),
      );
    });
    replace(
      account,
      'quoteSwap',
      (original) =>
        async (...args: never[]) =>
          wrapQuote(await original(...args), account),
    );
    replace(account, 'useSpendPermission', (original) => async (...args: never[]) => {
      const [opts] = args as unknown as [{ network?: unknown; value?: unknown } | undefined];
      return traced(
        chainIdFor(opts?.network),
        () => ({ from: addressOf(account) }),
        () => original(...args),
      );
    });
    replace(
      account,
      'useNetwork',
      (original) =>
        async (...args: never[]) =>
          wrapScopedAccount(await original(...args)),
    );
    return value;
  };

  const handle: HashspanCdp = { flush: (flushOptions) => viem.flush(flushOptions) };
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
      chainIdFor(opts?.network),
      () => ({ from: addressOf(opts?.address), ...describeTransaction(opts?.transaction) }),
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
  replace(evm, 'createSwapQuote', (original) => async (...args: never[]) => {
    const [opts] = args as unknown as [{ taker?: unknown; smartAccount?: unknown } | undefined];
    const quote = await original(...args);
    return opts?.smartAccount === undefined ? wrapQuote(quote, opts?.taker) : quote;
  });
  replace(evm, 'listAccounts', (original) => async (...args: never[]) => {
    const result = (await original(...args)) as { accounts?: unknown[] } | undefined;
    if (Array.isArray(result?.accounts)) result.accounts.forEach(wrapAccount);
    return result;
  });

  return handle;
}
