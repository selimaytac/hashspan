// Send and confirm spans of transactions sent through the CDP API (ADR 0012).
import type { ReceiptLike, ReplacementReason, SendInput, TxTracker } from '@hashspan/core';
import type { HashspanExtension } from '@hashspan/viem';
import { context, diag } from '@opentelemetry/api';
import { parseTransaction } from 'viem';
import type { ReaderFor } from './chain.js';
import {
  callChainId,
  errorName,
  failSend,
  isHexString,
  sendContextOf,
  stringOrUndefined,
} from './helpers.js';
import { own } from './own.js';
import type { Pending } from './pending.js';
import { receiptOf } from './receipt.js';
import {
  capturing,
  descriptorOf,
  isPlainObject,
  type ReplacementCapture,
  reportedReplacement,
  sameHex,
  shadowing,
} from './replacement.js';

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
  /**
   * Runs a network-scoped account's `waitForTransactionReceipt` inside a confirm span, without a reader. `wait` makes
   * the call with the options it is given.
   */
  confirmed(
    chainId: number,
    options: unknown,
    wait: (options: unknown) => Promise<unknown>,
  ): Promise<unknown>;
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
    const chainId = callChainId(chainIdOf);
    if (chainId === undefined) return send();
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
      const failed = handle;
      if (failed) failSend((what, errorType) => failed.fail(what, undefined, { errorType }), error);
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
    wait: (options: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    let traced: { hash: string; waitOptions: unknown; capture: ReplacementCapture } | undefined;
    try {
      traced = withReplacementCapture(chainId, options);
    } catch (error) {
      diag.error(
        `hashspan: failed to read the call options; call not traced (${errorName(error)})`,
      );
    }
    if (!traced) return wait(options);
    const { hash, waitOptions, capture } = traced;
    let handle: ReturnType<TxTracker['startConfirm']> | undefined;
    try {
      handle = tracker.startConfirm({ chainId, hash });
    } catch (error) {
      diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
    }
    const call = wait(waitOptions);
    if (handle) track(recordWait(handle, call, hash, capture));
    return call;
  };

  /**
   * The hash and the options a traced wait is made with, or undefined when it is passed on untraced: with a reader,
   * without a hash, or with an `onReplaced` accessor; it throws for options that cannot be read, such as a prototype
   * chain too long to read, and the caller passes those on untraced too. viem reports a replacement, matched on sender and nonce, through
   * `onReplaced` (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.12.0/docs/adr/0008-replaced-transactions.md).
   * The SDK passes viem's wait parameters on unchanged, so a capturing `onReplaced` is added to them; for
   * `{ transactionHash }` it would call viem with the hash alone, so that form is passed on as `{ hash, onReplaced }`,
   * the same viem call.
   */
  const withReplacementCapture = (
    chainId: number,
    options: unknown,
  ): { hash: string; waitOptions: unknown; capture: ReplacementCapture } | undefined => {
    const given = stringOrUndefined(own(options, 'hash'));
    const hash = given ?? own(options, 'transactionHash');
    if (typeof hash !== 'string' || readerFor(chainId)) return undefined;
    const capture: ReplacementCapture = {};
    if (given === undefined) {
      return { hash, waitOptions: { hash, onReplaced: capturing(capture, undefined) }, capture };
    }
    // viem reads the callback through the prototype chain as well.
    const onReplaced = descriptorOf(options as object, 'onReplaced');
    if (onReplaced !== undefined && !('value' in onReplaced)) return undefined;
    // Options that are not a plain object, such as a class instance, are passed on as they are: the wait is traced,
    // but a replacement is not attributed.
    if (!isPlainObject(options as object)) return { hash, waitOptions: options, capture };
    const waitOptions = shadowing(
      options as object,
      'onReplaced',
      capturing(capture, onReplaced?.value),
    );
    return { hash, waitOptions, capture };
  };

  /**
   * Ends `handle` from the outcome of the user's wait; never rejects. It is tracked, so `flush()` waits for it and
   * ends it as `timeout` if it cannot wait longer
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.12.0/docs/adr/0010-flush-before-shutdown.md).
   */
  const recordWait = (
    handle: ReturnType<TxTracker['startConfirm']>,
    call: Promise<unknown>,
    hash: string,
    capture: ReplacementCapture,
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
          if (receipt) recordReceipt(handle, hash, receipt, capture);
          else handle.fail(new TypeError('not a transaction receipt'));
        }, 'receipt');
      },
      (error: unknown) => {
        end(() => {
          // viem rejects after reporting a replacement only if the caller's onReplaced threw: the transaction was
          // mined, so the reported receipt is recorded.
          const reported = receiptOf(reportedReplacement(capture)?.receipt);
          if (reported) recordReceipt(handle, hash, reported, capture);
          else if (
            error instanceof Error &&
            own(error, 'name') === 'WaitForTransactionReceiptTimeoutError'
          ) {
            handle.timeout();
          } else handle.fail(error);
        }, 'confirmation failure');
      },
    );
  };

  return { traced, confirmed };
}

/**
 * Ends `handle` with `receipt`. A receipt of another hash is the awaited transaction's only as a replacement viem
 * reported, recorded with its reason; any other, such as an endpoint's answer for an unrelated transaction, is not
 * recorded, and the span ends as a failure with `error.type` `_OTHER`.
 */
function recordReceipt(
  handle: ReturnType<TxTracker['startConfirm']>,
  hash: string,
  receipt: ReceiptLike,
  capture: ReplacementCapture,
): void {
  const report = reportedReplacement(capture);
  const reported =
    report !== undefined &&
    sameHex(own(report.receipt, 'transactionHash'), receipt.transactionHash);
  if (
    !reported &&
    receipt.transactionHash !== undefined &&
    !sameHex(receipt.transactionHash, hash)
  ) {
    diag.debug(
      'hashspan: the wait resolved with the receipt of another transaction; not recording it',
    );
    handle.fail(undefined);
    return;
  }
  const reason = reported ? report.reason : undefined;
  handle.end(
    typeof reason === 'string'
      ? { ...receipt, replacementReason: reason as ReplacementReason }
      : receipt,
  );
}
