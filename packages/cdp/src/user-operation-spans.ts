// Send and confirm spans of user operations sent by smart accounts (ADR 0021).
import type {
  TxTracker,
  UserOperationConfirmHandle,
  UserOperationInput,
  UserOperationReceiptLike,
} from '@hashspan/core';
import type { ViemClientLike } from '@hashspan/viem';
import { context, diag } from '@opentelemetry/api';
import type { ReaderFor } from './chain.js';
import {
  cdpErrorType,
  errorName,
  isHexString,
  sendContextOf,
  stringOrUndefined,
  timers,
} from './helpers.js';
import { own } from './own.js';
import type { Pending } from './pending.js';
import { SentUserOperations, userOperationReceiptFromBundle } from './user-operation.js';

// The user operations whose chain and sender are remembered for later waits.
const MAX_SENT_USER_OPERATIONS = 4096;
// The same default as the confirmations through the reader (`confirmTimeoutMs`).
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
// `error.type` of a confirm span whose outcome could not be read.
const ERROR_TYPE_OTHER = '_OTHER';
// How often the reader is asked for a bundle receipt when it has no polling interval of its own.
const DEFAULT_POLLING_INTERVAL_MS = 1000;

/** What the user operation spans need from the `withHashspan()` call. */
export interface UserOperationSpansDependencies {
  tracker: TxTracker;
  readerFor: ReaderFor;
  track: Pending['track'];
  waiting: Pending['waiting'];
  confirmTimeoutMs: number | undefined;
}

export interface UserOperationSpans {
  /** Runs `send`, which hands a user operation to CDP, inside a user operation send span when the chain id is known. */
  tracedUserOperation(
    chainIdOf: () => number | undefined,
    describe: () => Omit<UserOperationInput, 'chainId'>,
    send: () => Promise<unknown>,
  ): Promise<unknown>;
  /** Runs a `waitForUserOperation` inside the user operation's confirm span. */
  confirmedUserOperation(
    chainId: number | undefined,
    smartAccountAddress: () => unknown,
    options: unknown,
    wait: () => Promise<unknown>,
  ): Promise<unknown>;
}

export function createUserOperationSpans({
  tracker,
  readerFor,
  track,
  waiting,
  confirmTimeoutMs,
}: UserOperationSpansDependencies): UserOperationSpans {
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
    /**
     * Ends the handle once with `record`, which reads the outcome and calls a handle method. If that throws (an
     * outcome that cannot be read), the handle still ends, as a failure with `error.type` `_OTHER`; the abandon
     * callback is removed only once a handle method was called (ADR 0025 rule 1).
     */
    const end = (record: () => void, what: string): void => {
      if (ended) return;
      ended = true;
      try {
        record();
      } catch (error) {
        diag.error(`hashspan: failed to record ${what} (${errorName(error)})`);
        try {
          handle.fail(undefined, { errorType: ERROR_TYPE_OTHER });
        } catch (failure) {
          diag.error(`hashspan: failed to end the confirm span (${errorName(failure)})`);
        }
      }
      waiting.delete(abandon);
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
            error instanceof Error && own(error, 'name') === 'TimeoutError'
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

  return { tracedUserOperation, confirmedUserOperation };
}
