// Confirming a transaction through a client: the receipt, a sealed receipt after a preconfirmation, the revert
// reason, and background confirmation within its limit.
import type { ConfirmHandle, TxTracker } from '@hashspan/core';
import { diag, type TimeInput } from '@opentelemetry/api';
import { type Abi, type TransactionReceipt, WaitForTransactionReceiptTimeoutError } from 'viem';
import { waitForTransactionReceipt as viemWaitForTransactionReceipt } from 'viem/actions';
import { fetchRevertReason } from '../revert-reason.js';
import { errorName } from '../safe-tracker.js';
import type { ViemClientLike } from '../types.js';
import type { PendingConfirmation } from './pending.js';
import {
  capturing,
  isPreconfirmed,
  isReadable,
  isReceiptLag,
  isTimeout,
  RECEIPT_LAG_RETRY_MS,
  type ReplacementCapture,
  sameHex,
  sealedReceipt,
  toReceiptLike,
  unreadable,
  type ViemReceipt,
  withoutFees,
} from './receipt.js';
import { confirmKey, type Recent } from './recent.js';
import { delay, durationOr, within } from './timing.js';

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
/** How long telemetry waits for the sealed receipt of a preconfirmed transaction before it records it without fees. */
const SEALED_RECEIPT_TIMEOUT_MS = 30_000;

/** What confirming needs from the `withHashspan()` call it belongs to. */
export interface ConfirmationOptions {
  /** The guarded tracker. */
  tracker: TxTracker;
  decodeRevertReason: boolean;
  revertReasonTimeoutMs: number;
  maxBackgroundConfirmations: number;
  /** ABIs of recent `writeContract` calls, to decode custom errors. */
  abis: Recent<Abi>;
  /** Revert reasons being or already fetched, so concurrent waits for one transaction fetch it once. */
  revertReasons: Recent<Promise<string | undefined>>;
  track(work: Promise<void>): void;
  settleOnce(handle: ConfirmHandle): PendingConfirmation;
}

export interface Confirmation {
  /**
   * Records the outcome of `wait` on `waitingHandle`; never rejects. Resolves as soon as the handle has ended,
   * including when a flush that gave up ended it, so the tracked work drains.
   */
  recordConfirmation(
    chainId: number,
    hash: string,
    waitingHandle: ConfirmHandle,
    wait: Promise<ViemReceipt>,
    capture: ReplacementCapture,
    client: unknown,
    endTimeOf?: () => TimeInput | undefined,
    deadline?: number,
  ): Promise<void>;
  /**
   * Starts a confirm span for `hash` and polls for its receipt through `client`, off the caller's path. Returns false,
   * recording nothing, when `maxBackgroundConfirmations` are already polling.
   */
  confirmThrough(
    client: ViemClientLike,
    chainId: number,
    hash: string,
    timeoutMs: number,
    onReceipt?: (receipt: TransactionReceipt | undefined) => void,
  ): boolean;
}

export function createConfirmation({
  tracker,
  decodeRevertReason,
  revertReasonTimeoutMs,
  maxBackgroundConfirmations,
  abis,
  revertReasons,
  track,
  settleOnce,
}: ConfirmationOptions): Confirmation {
  /** Background confirmations polling now, and whether the limit was reported since the count was last below it. */
  let backgroundCount = 0;
  let limitReported = false;

  /** Revert reason of a mined transaction, fetched once per transaction (keyed by its hash). */
  const revertReasonOf = (
    key: string,
    receipt: ViemReceipt,
    abi: Abi | undefined,
    client: unknown,
  ): Promise<string | undefined> => {
    let reason = revertReasons.get(key);
    if (!reason) {
      const fetched = fetchRevertReason(
        client,
        receipt.transactionHash,
        receipt.blockNumber,
        abi,
      ).catch((error: unknown) => {
        diag.debug(`hashspan: could not fetch revert reason (${errorName(error)})`);
        return undefined;
      });
      // Bounded, so that an unresponsive provider cannot keep the confirm span open.
      reason = within(fetched, revertReasonTimeoutMs, 'fetch the revert reason');
      revertReasons.set(key, reason);
    }
    return reason;
  };

  /**
   * Ends `handle` from the outcome of `wait`; never rejects. The tracker joins handles for one transaction into one
   * confirm span
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0007-confirmation-ownership.md) and
   * attributes the receipt of a replacing transaction to that transaction
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0008-replaced-transactions.md). For
   * reverted receipts, the span ends after the revert reason was fetched with `client`. For a preconfirmed receipt, it
   * ends with the sealed receipt, read with `client` until `deadline` at the latest
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0024-sealed-receipt-fees.md).
   */
  const recordReceipt = async (
    chainId: number,
    hash: string,
    confirmation: PendingConfirmation,
    wait: Promise<ViemReceipt>,
    capture: ReplacementCapture,
    client: unknown,
    endTimeOf: () => TimeInput | undefined = () => undefined,
    deadline?: number,
  ): Promise<void> => {
    const { handle } = confirmation;
    let receipt: ViemReceipt;
    try {
      receipt = await wait;
    } catch (error) {
      // viem rejects after reporting a replacement only if the caller's onReplaced threw: the transaction was mined.
      const reported = capture.replacement?.transactionReceipt;
      if (!reported) {
        if (!isReadable(error)) handle.fail(undefined, unreadable(endTimeOf()));
        else if (isTimeout(error)) handle.timeout(endTimeOf());
        else handle.fail(error, endTimeOf());
        return;
      }
      receipt = reported;
    }
    try {
      const { replacement } = capture;
      const reported =
        replacement !== undefined &&
        sameHex(replacement.transactionReceipt.transactionHash, receipt.transactionHash);
      const replacementReason = reported ? replacement.reason : undefined;
      let recorded = toReceiptLike(receipt);
      let endAt = endTimeOf;
      if (isPreconfirmed(receipt)) {
        // The span ends when the receipt arrived, not when the sealed one was read, so its duration stays the wait's.
        const arrivedAt = endTimeOf() ?? new Date();
        endAt = () => arrivedAt;
        // Its fee may be another transaction's. A flush that cannot wait records it without fees.
        const preconfirmed = { ...withoutFees(recorded), replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(preconfirmed, endAt()));
        const sealed = await sealedReceipt(
          client,
          receipt,
          Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + SEALED_RECEIPT_TIMEOUT_MS),
        );
        if (sealed) {
          receipt = sealed;
          recorded = toReceiptLike(sealed);
        } else {
          diag.warn(
            'hashspan: no sealed receipt for a preconfirmed transaction; recording it without fees',
          );
          recorded = withoutFees(recorded);
        }
      }
      let revertReason: string | undefined;
      // A malformed hash is left to the tracker, which does not attribute it.
      if (
        receipt.status === 'reverted' &&
        decodeRevertReason &&
        typeof receipt.transactionHash === 'string'
      ) {
        const minedKey = confirmKey(chainId, receipt.transactionHash);
        // Errors are matched by selector, so the original call's ABI fits a replacing call to the same contract.
        const abi =
          abis.get(minedKey) ??
          (minedKey === confirmKey(chainId, hash) ||
          (reported && sameHex(replacement.transaction.to, replacement.replacedTransaction.to))
            ? abis.get(confirmKey(chainId, hash))
            : undefined);
        // The receipt is known: a flush that cannot wait for the reason records the receipt without it.
        const mined = { ...recorded, replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(mined, endAt()));
        revertReason = await revertReasonOf(minedKey, receipt, abi, client);
      }
      handle.end({ ...recorded, revertReason, replacementReason }, endAt());
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
      handle.fail(error, endTimeOf());
    }
  };
  /**
   * Records the outcome of `wait` on `waitingHandle`; never rejects. Resolves as soon as the handle has ended,
   * including when a flush that gave up ended it
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0010-flush-before-shutdown.md), so the
   * tracked work drains.
   */
  const recordConfirmation = (
    chainId: number,
    hash: string,
    waitingHandle: ConfirmHandle,
    wait: Promise<ViemReceipt>,
    capture: ReplacementCapture,
    client: unknown,
    endTimeOf: () => TimeInput | undefined = () => undefined,
    deadline?: number,
  ): Promise<void> => {
    const confirmation = settleOnce(waitingHandle);
    return Promise.race([
      recordReceipt(chainId, hash, confirmation, wait, capture, client, endTimeOf, deadline),
      confirmation.ended,
    ]);
  };

  /**
   * Each client under its own `uid`, for background confirmation. viem joins concurrent `waitForTransactionReceipt`
   * calls with the same client `uid` and hash into one poll that runs with the first call's options: sharing it would
   * apply the background timeout and confirmations to the caller's own wait. One `uid` per client, since viem also
   * caches by `uid`.
   */
  const backgroundClients = new WeakMap<object, ViemClientLike>();
  const backgroundClientOf = (client: ViemClientLike): ViemClientLike => {
    let background = backgroundClients.get(client);
    if (!background) {
      background =
        typeof client.uid === 'string' ? { ...client, uid: `${client.uid}:hashspan` } : client;
      backgroundClients.set(client, background);
    }
    return background;
  };

  /**
   * Starts a confirm span for `hash` and polls for its receipt through `client`, off the caller's path. Returns false,
   * recording nothing, when `maxBackgroundConfirmations` are already polling.
   */
  const confirmThrough = (
    client: ViemClientLike,
    chainId: number,
    hash: string,
    timeoutMs: number,
    onReceipt?: (receipt: TransactionReceipt | undefined) => void,
  ): boolean => {
    if (backgroundCount >= maxBackgroundConfirmations) {
      if (!limitReported) {
        limitReported = true;
        diag.warn(
          `hashspan: ${maxBackgroundConfirmations} background confirmations are already polling; not confirming more until one ends (maxBackgroundConfirmations)`,
        );
      }
      return false;
    }
    const handle = tracker.startConfirm({ chainId, hash });
    const capture: ReplacementCapture = {};
    const waitMs = durationOr(timeoutMs, DEFAULT_BACKGROUND_TIMEOUT_MS);
    const background = backgroundClientOf(client);
    const polling = (client as { pollingInterval?: unknown }).pollingInterval;
    const retryMs = typeof polling === 'number' && polling > 0 ? polling : RECEIPT_LAG_RETRY_MS;
    const deadline = Date.now() + waitMs;
    const wait = async (): Promise<ViemReceipt> => {
      for (;;) {
        try {
          return (await viemWaitForTransactionReceipt(background as never, {
            hash: hash as `0x${string}`,
            timeout: Math.max(deadline - Date.now(), 1),
            onReplaced: capturing(capture, undefined) as never,
          })) as ViemReceipt;
        } catch (error) {
          // viem rejects on the first failed request of its poll; only its timeout and a replacement are final.
          if (isTimeout(error) || capture.replacement) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new WaitForTransactionReceiptTimeoutError({ hash: hash as `0x${string}` });
          diag.debug(
            isReceiptLag(error)
              ? 'hashspan: the node returned the transaction before its receipt; waiting again'
              : `hashspan: a receipt request failed (${errorName(error)}); waiting again`,
          );
          await delay(Math.min(retryMs, remaining));
        }
      }
    };
    backgroundCount++;
    const waited = wait();
    const release = (): void => {
      backgroundCount--;
      if (backgroundCount < maxBackgroundConfirmations) limitReported = false;
    };
    waited.then(release, release);
    track(recordConfirmation(chainId, hash, handle, waited, capture, client, undefined, deadline));
    // Not tracked: flush() waits for the confirm span, not for the caller's callback.
    if (onReceipt) {
      void waited.then(
        (receipt) => onReceipt(receipt as unknown as TransactionReceipt),
        () => onReceipt(undefined),
      );
    }
    return true;
  };

  return { recordConfirmation, confirmThrough };
}
