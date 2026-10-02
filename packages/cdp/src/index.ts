import {
  createTxTracker,
  type ReceiptLike,
  type SendInput,
  type TxTracker,
  type UserOperationConfirmHandle,
  type UserOperationInput,
  type UserOperationReceiptLike,
} from '@hashspan/core';
import {
  type FlushOptions,
  type ViemClientLike,
  type WithHashspanOptions as ViemOptions,
  withHashspan as withViemHashspan,
} from '@hashspan/viem';
import { type Context, context, diag } from '@opentelemetry/api';
import { parseTransaction } from 'viem';
import { CDP_API_SEND_CHAIN_IDS, chainIdOf } from './networks.js';
import { own } from './own.js';
import { SentUserOperations, userOperationReceiptFromBundle } from './user-operation.js';

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
   * https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.7.0/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
}

// Structural views of the CDP SDK objects, so that the adapter does not depend on its internal types.
type AnyFn = (...args: never[]) => Promise<unknown>;
interface CdpClientLike {
  // `object`, not a record type: the SDK's `EvmClient` class has no index signature.
  evm: object;
}
interface AccountLike {
  address?: unknown;
  [key: string]: unknown;
}
const WRAPPED = Symbol.for('hashspan.cdp.wrapped');
// The same default as @hashspan/viem's flush().
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
// Timers without Node.js or DOM types, which src/ is type-checked without.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};
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
// `listSmartAccounts` is not among them: it returns plain records without methods.
const SMART_ACCOUNT_FACTORIES = [
  'createSmartAccount',
  'getSmartAccount',
  'getOrCreateSmartAccount',
  'updateSmartAccount',
] as const;
// The user operations whose chain and sender are remembered for later waits.
const MAX_SENT_USER_OPERATIONS = 4096;
// The same default as the confirmations through the reader (`confirmTimeoutMs`).
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
// How often the reader is asked for a bundle receipt when it has no polling interval of its own.
const DEFAULT_POLLING_INTERVAL_MS = 1000;

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'unknown error';
}

/**
 * The context a send handle's call runs in: its send context, or the caller's for a handle without a usable one, such
 * as one from a tracker of a core before 0.4 (ADR 0014).
 */
function sendContextOf(handle: { context?: unknown } | undefined): Context {
  const caller = context.active();
  try {
    const sendContext = handle?.context;
    return typeof sendContext === 'object' &&
      sendContext !== null &&
      typeof (sendContext as { getValue?: unknown }).getValue === 'function'
      ? (sendContext as Context)
      : caller;
  } catch (error) {
    diag.debug(`hashspan: could not read the send context (${errorName(error)})`);
    return caller;
  }
}

/** The CDP API's error type (`APIError.errorType`, e.g. `insufficient_balance`), recorded as `error.type`. */
function cdpErrorType(error: unknown): string | undefined {
  const type = error instanceof Error ? own(error, 'errorType') : undefined;
  return typeof type === 'string' ? type : undefined;
}

/** The fields of a viem receipt that the confirm span records, or undefined if `value` is not one. */
function receiptOf(value: unknown): ReceiptLike | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const status = own(value, 'status');
  const blockNumber = own(value, 'blockNumber');
  const gasUsed = own(value, 'gasUsed');
  if (status !== 'success' && status !== 'reverted') return undefined;
  if (typeof blockNumber !== 'bigint' || typeof gasUsed !== 'bigint') return undefined;
  const optional = (v: unknown) => (typeof v === 'bigint' ? v : undefined);
  return {
    status,
    blockNumber,
    gasUsed,
    effectiveGasPrice: optional(own(value, 'effectiveGasPrice')),
    l1Fee: optional(own(value, 'l1Fee')),
    transactionHash: stringOrUndefined(own(value, 'transactionHash')),
  };
}

function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function addressOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : stringOrUndefined(own(value, 'address'));
}

/** Transaction fields for the send span, from a request object or a serialized transaction. */
function describeTransaction(transaction: unknown): Omit<SendInput, 'chainId'> {
  let request: object | undefined;
  if (isHexString(transaction)) {
    try {
      request = parseTransaction(transaction);
    } catch {
      diag.debug('hashspan: could not parse the serialized transaction');
    }
  } else if (transaction !== null && typeof transaction === 'object') {
    request = transaction;
  }
  if (!request) return {};
  const data = own(request, 'data');
  const value = own(request, 'value');
  const nonce = own(request, 'nonce');
  return {
    to: stringOrUndefined(own(request, 'to')),
    value: typeof value === 'bigint' ? value : undefined,
    nonce: typeof nonce === 'number' ? nonce : undefined,
    functionSelector: typeof data === 'string' && data.length >= 10 ? data.slice(0, 10) : undefined,
  };
}

/**
 * Traces transactions sent by a Coinbase CDP client's EVM server accounts, and user operations of its smart accounts,
 * with `@hashspan/core` (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.7.0/docs/adr/0012-cdp-adapter.md,
 * https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.7.0/docs/adr/0021-user-operations.md). It wraps the
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

  // Work this adapter runs itself, outside @hashspan/viem: confirm spans of network-scoped waits without a reader.
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  /** Ends a tracked confirm span that is still open as `timeout`, for `flush()` to call when it gives up. */
  const waiting = new Set<() => void>();

  const flushOwn = async (timeoutMs: number): Promise<boolean> => {
    const settled = await new Promise<boolean>((resolve) => {
      const timer = timers.setTimeout(() => resolve(false), timeoutMs);
      void Promise.all([...pending]).then(() => {
        timers.clearTimeout(timer);
        resolve(true);
      });
    });
    if (!settled) for (const abandon of [...waiting]) abandon();
    return settled;
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

  /**
   * Runs `send` inside a send span when the chain id is known; the result and errors are passed on unchanged. If
   * reading the chain id from the call's options throws, the call is made untraced.
   */
  const traced = async (
    chainIdOf: () => number | undefined,
    describe: () => Omit<SendInput, 'chainId'>,
    send: () => Promise<unknown>,
  ): Promise<unknown> => {
    let chainId: number | undefined;
    try {
      chainId = chainIdOf();
    } catch (error) {
      diag.error(
        `hashspan: failed to read the call options; call not traced (${errorName(error)})`,
      );
      return send();
    }
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
      // Only the call runs in the send span's context, so the spans it creates nest under the send span; what
      // follows runs in the caller's (ADR 0015).
      result = await context.with(sendContextOf(handle), send);
    } catch (error) {
      try {
        handle?.fail(error, undefined, { errorType: cdpErrorType(error) });
      } catch (thrown) {
        diag.error(`hashspan: failed to record send failure (${errorName(thrown)})`);
      }
      throw error;
    }
    try {
      const hash = own(result, 'transactionHash');
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
  const confirmed = (
    chainId: number,
    options: unknown,
    wait: () => Promise<unknown>,
  ): Promise<unknown> => {
    let hash: unknown;
    try {
      hash = stringOrUndefined(own(options, 'hash')) ?? own(options, 'transactionHash');
    } catch (error) {
      diag.error(
        `hashspan: failed to read the call options; call not traced (${errorName(error)})`,
      );
      return wait();
    }
    if (typeof hash !== 'string' || readerFor(chainId)) return wait();
    let handle: ReturnType<TxTracker['startConfirm']> | undefined;
    try {
      handle = tracker.startConfirm({ chainId, hash });
    } catch (error) {
      diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
    }
    const call = wait();
    if (handle) track(recordWait(handle, call));
    return call;
  };

  /**
   * Ends `handle` from the outcome of the user's wait; never rejects. It is tracked, so `flush()` waits for it and
   * ends it as `timeout` if it cannot wait longer
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.7.0/docs/adr/0010-flush-before-shutdown.md).
   */
  const recordWait = (
    handle: ReturnType<TxTracker['startConfirm']>,
    call: Promise<unknown>,
  ): Promise<void> => {
    let ended = false;
    const end = (record: () => void, what: string): void => {
      if (ended) return;
      ended = true;
      waiting.delete(abandon);
      try {
        record();
      } catch (error) {
        diag.error(`hashspan: failed to record ${what} (${errorName(error)})`);
      }
    };
    const abandon = (): void => end(() => handle.timeout(), 'confirmation timeout');
    waiting.add(abandon);
    return call.then(
      (result) => {
        const receipt = receiptOf(result);
        end(
          () =>
            receipt ? handle.end(receipt) : handle.fail(new TypeError('not a transaction receipt')),
          'receipt',
        );
      },
      (error: unknown) => {
        end(
          () =>
            error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError'
              ? handle.timeout()
              : handle.fail(error),
          'confirmation failure',
        );
      },
    );
  };

  const sentUserOperations = new SentUserOperations(MAX_SENT_USER_OPERATIONS);
  let warnedOldTracker = false;
  /** Whether the tracker records user operations; one from a core before 0.8 does not (ADR 0014). */
  const tracesUserOperations = (): boolean => {
    let able = false;
    try {
      able =
        typeof tracker.startUserOperationSend === 'function' &&
        typeof tracker.startUserOperationConfirm === 'function';
    } catch (error) {
      diag.debug(`hashspan: could not inspect the tracker (${errorName(error)})`);
    }
    if (!able && !warnedOldTracker) {
      warnedOldTracker = true;
      diag.warn(
        'hashspan: not tracing user operations: the tracker has no startUserOperationSend; use createTxTracker() from @hashspan/core 0.8 or later',
      );
    }
    return able;
  };

  /**
   * Runs `send`, which hands a user operation to CDP, inside a user operation send span when the chain id is known;
   * the result and errors are passed on unchanged. If reading the call's options throws, the call is made untraced.
   */
  const tracedUserOperation = async (
    chainIdOf: () => number | undefined,
    describe: () => Omit<UserOperationInput, 'chainId'>,
    send: () => Promise<unknown>,
  ): Promise<unknown> => {
    let chainId: number | undefined;
    try {
      chainId = chainIdOf();
    } catch (error) {
      diag.error(
        `hashspan: failed to read the call options; call not traced (${errorName(error)})`,
      );
      return send();
    }
    if (chainId === undefined) {
      diag.debug('hashspan: no known CDP network in the call; not tracing it');
      return send();
    }
    if (!tracesUserOperations()) return send();
    let input: Omit<UserOperationInput, 'chainId'> = {};
    let handle: ReturnType<TxTracker['startUserOperationSend']> | undefined;
    try {
      input = describe();
      handle = tracker.startUserOperationSend({ ...input, chainId });
    } catch (error) {
      diag.error(`hashspan: failed to start send span (${errorName(error)})`);
    }
    let result: unknown;
    try {
      // As for transactions, only the call runs in the send span's context (ADR 0015).
      result = await context.with(sendContextOf(handle), send);
    } catch (error) {
      try {
        handle?.fail(error, { errorType: cdpErrorType(error) });
      } catch (thrown) {
        diag.error(`hashspan: failed to record send failure (${errorName(thrown)})`);
      }
      throw error;
    }
    try {
      const userOpHash = own(result, 'userOpHash');
      if (typeof userOpHash === 'string') {
        handle?.end({ userOpHash });
        const sender = input.sender ?? stringOrUndefined(own(result, 'smartAccountAddress'));
        sentUserOperations.add(userOpHash, chainId, sender);
      } else {
        handle?.fail(new TypeError('no userOpHash in the CDP result'));
      }
    } catch (error) {
      diag.error(`hashspan: failed to record send span (${errorName(error)})`);
    }
    return result;
  };

  /**
   * Runs a `waitForUserOperation` inside the user operation's confirm span. The wait names no network: the chain is
   * `chainId` for a network-scoped account, else the one the operation was sent on through this client; a wait for
   * an operation sent elsewhere is passed on untraced. The result and errors are passed on unchanged.
   */
  const confirmedUserOperation = (
    chainId: number | undefined,
    smartAccountAddress: () => unknown,
    options: unknown,
    wait: () => Promise<unknown>,
  ): Promise<unknown> => {
    let userOpHash: unknown;
    let chain: number | undefined;
    let sender: string | undefined;
    try {
      userOpHash = own(options, 'userOpHash');
      const sent = typeof userOpHash === 'string' ? sentUserOperations.get(userOpHash) : undefined;
      chain = chainId ?? sent?.chainId;
      sender = stringOrUndefined(smartAccountAddress()) ?? sent?.sender;
    } catch (error) {
      diag.error(
        `hashspan: failed to read the call options; call not traced (${errorName(error)})`,
      );
      return wait();
    }
    if (typeof userOpHash !== 'string') return wait();
    if (chain === undefined) {
      diag.debug('hashspan: a user operation sent elsewhere; not tracing its wait');
      return wait();
    }
    if (!tracesUserOperations()) return wait();
    let handle: UserOperationConfirmHandle | undefined;
    try {
      handle = tracker.startUserOperationConfirm({ chainId: chain, userOpHash });
    } catch (error) {
      diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
    }
    const call = wait();
    if (handle) track(recordUserOperationWait(handle, call, chain, userOpHash, sender));
    return call;
  };

  /**
   * Ends `handle` from the outcome of the user's `waitForUserOperation`; never rejects. CDP reports `complete` with
   * the bundle transaction's hash, or `failed` without a reason. With a reader, the bundle receipt's
   * `UserOperationEvent` adds the operation's success, gas and paymaster; the span still ends when the wait did. It
   * is tracked, so `flush()` waits for it; if `flush()` gives up, a completed operation ends with what is known, and
   * one still awaited as `timeout`.
   */
  const recordUserOperationWait = (
    handle: UserOperationConfirmHandle,
    call: Promise<unknown>,
    chainId: number,
    userOpHash: string,
    sender: string | undefined,
  ): Promise<void> => {
    let ended = false;
    let completed: { receipt: UserOperationReceiptLike; endTime: Date } | undefined;
    const end = (record: () => void, what: string): void => {
      if (ended) return;
      ended = true;
      waiting.delete(abandon);
      try {
        record();
      } catch (error) {
        diag.error(`hashspan: failed to record ${what} (${errorName(error)})`);
      }
    };
    const abandon = (): void =>
      end(
        () =>
          completed
            ? handle.end(completed.receipt, { endTime: completed.endTime })
            : handle.timeout(),
        'user operation confirmation',
      );
    waiting.add(abandon);
    const outcome = async (result: unknown): Promise<void> => {
      const endTime = new Date();
      const status = own(result, 'status');
      if (status === 'failed') {
        end(() => handle.fail(undefined, { errorType: 'failed', endTime }), 'failed operation');
        return;
      }
      const transactionHash = own(result, 'transactionHash');
      if (status !== 'complete' || typeof transactionHash !== 'string') {
        end(
          () => handle.fail(new TypeError('not a user operation result'), { endTime }),
          'user operation result',
        );
        return;
      }
      // Without a reader, CDP's answer says nothing about whether the operation's calls succeeded.
      completed = { receipt: { transactionHash }, endTime };
      const client = isHexString(transactionHash) ? readerFor(chainId) : undefined;
      if (client) {
        const raw = await bundleReceipt(client, transactionHash, () => ended);
        if (raw) completed.receipt = userOperationReceiptFromBundle(raw, userOpHash, sender);
      }
      const { receipt } = completed;
      end(() => handle.end(receipt, { endTime }), 'user operation receipt');
    };
    return call.then(
      (result) =>
        outcome(result).catch((error: unknown) => {
          end(() => handle.fail(error), 'user operation receipt');
        }),
      (error: unknown) => {
        end(
          () =>
            // The SDK's wait gives up with a TimeoutError; the operation may still complete.
            error instanceof Error && error.name === 'TimeoutError'
              ? handle.timeout()
              : handle.fail(error),
          'confirmation failure',
        );
      },
    );
  };

  /**
   * The node's raw receipt of a bundle transaction, polled through the reader until it is found, `stopped()`, or
   * `confirmTimeoutMs` passed. It calls the client's `request` directly, so a reader extended by `@hashspan/viem`
   * records no transaction confirm span for the bundle, whose fee covers every operation in it (ADR 0021).
   */
  const bundleReceipt = async (
    client: ViemClientLike,
    hash: string,
    stopped: () => boolean,
  ): Promise<unknown> => {
    const polling = own(client, 'pollingInterval');
    const interval =
      typeof polling === 'number' && polling > 0 ? polling : DEFAULT_POLLING_INTERVAL_MS;
    const deadline = Date.now() + (confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);
    for (;;) {
      try {
        const raw: unknown = await client.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        });
        if (raw !== null && typeof raw === 'object') return raw;
      } catch (error) {
        diag.debug(`hashspan: could not read the bundle receipt (${errorName(error)})`);
      }
      if (stopped() || Date.now() + interval > deadline) return undefined;
      await new Promise<void>((resolve) => timers.setTimeout(resolve, interval));
    }
  };

  /**
   * Replaces `target[name]` with `wrap(original)`, calling the original with `target` as `this`. Returns false when
   * the method cannot be replaced, for example on a frozen object; a method replaced before is left as it is, so
   * wrapping an object again never traces a call twice.
   */
  const replace = (
    target: Record<string, unknown>,
    name: string,
    wrap: (original: AnyFn) => AnyFn,
  ): boolean => {
    try {
      const original = target[name];
      if (typeof original !== 'function' || WRAPPED in original) return true;
      const wrapper = wrap((original as AnyFn).bind(target));
      Object.defineProperty(wrapper, WRAPPED, { value: true });
      target[name] = wrapper;
      return target[name] === wrapper;
    } catch (error) {
      diag.error(`hashspan: failed to wrap ${name} (${errorName(error)})`);
      return false;
    }
  };

  /** Logs a failure to wrap a value the SDK returned; the value is then returned as it is. */
  const wrapFailed = (error: unknown): void => {
    diag.error(`hashspan: failed to wrap a CDP result (${errorName(error)})`);
  };

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
