// Send and confirm spans of transactions sent through the CDP API (ADR 0012).
import type { SendInput, TxTracker } from '@hashspan/core';
import type { HashspanExtension } from '@hashspan/viem';
import { context, diag } from '@opentelemetry/api';
import { parseTransaction } from 'viem';
import type { ReaderFor } from './chain.js';
import {
  cdpErrorType,
  errorName,
  isHexString,
  sendContextOf,
  stringOrUndefined,
} from './helpers.js';
import { own } from './own.js';
import type { Pending } from './pending.js';
import { receiptOf } from './receipt.js';

/** Transaction fields for the send span, from a request object or a serialized transaction. */
export function describeTransaction(transaction: unknown): Omit<SendInput, 'chainId'> {
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

/** What the transaction spans need from the `withHashspan()` call. */
export interface TransactionSpansDependencies {
  tracker: TxTracker;
  viem: HashspanExtension;
  readerFor: ReaderFor;
  track: Pending['track'];
  waiting: Pending['waiting'];
  confirmTimeoutMs: number | undefined;
}

export interface TransactionSpans {
  /** Runs `send` inside a send span when the chain id is known. */
  traced(
    chainIdOf: () => number | undefined,
    describe: () => Omit<SendInput, 'chainId'>,
    send: () => Promise<unknown>,
  ): Promise<unknown>;
  /** Runs a network-scoped account's `waitForTransactionReceipt` inside a confirm span, without a reader. */
  confirmed(chainId: number, options: unknown, wait: () => Promise<unknown>): Promise<unknown>;
}

export function createTransactionSpans({
  tracker,
  viem,
  readerFor,
  track,
  waiting,
  confirmTimeoutMs,
}: TransactionSpansDependencies): TransactionSpans {
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
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.9.1/docs/adr/0010-flush-before-shutdown.md).
   */
  const recordWait = (
    handle: ReturnType<TxTracker['startConfirm']>,
    call: Promise<unknown>,
  ): Promise<void> => {
    let ended = false;
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
          handle.fail(undefined);
        } catch (failure) {
          diag.error(`hashspan: failed to end the confirm span (${errorName(failure)})`);
        }
      }
      waiting.delete(abandon);
    };
    const abandon = (): void => end(() => handle.timeout(), 'confirmation timeout');
    waiting.add(abandon);
    return call.then(
      (result) => {
        end(() => {
          const receipt = receiptOf(result);
          if (receipt) handle.end(receipt);
          else handle.fail(new TypeError('not a transaction receipt'));
        }, 'receipt');
      },
      (error: unknown) => {
        end(
          () =>
            error instanceof Error && own(error, 'name') === 'WaitForTransactionReceiptTimeoutError'
              ? handle.timeout()
              : handle.fail(error),
          'confirmation failure',
        );
      },
    );
  };

  return { traced, confirmed };
}
