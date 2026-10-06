// Confirming a transaction through a client: the receipt, a sealed receipt after a preconfirmation, the receipt of a
// wait for several confirmations read again, the revert reason, background confirmation within its limit, and the
// wait that follows a pending receipt of a sync send.
import type { ConfirmHandle, ReceiptLike, TxTracker } from '@hashspan/core';
import { type Context, context, diag, type TimeInput } from '@opentelemetry/api';
import { type Abi, type TransactionReceipt, WaitForTransactionReceiptTimeoutError } from 'viem';
import {
  getTransactionReceipt as viemGetTransactionReceipt,
  waitForTransactionReceipt as viemWaitForTransactionReceipt,
} from 'viem/actions';
import { fetchRevertReason } from '../revert-reason.js';
import { errorName } from '../safe-tracker.js';
import type { ViemClientLike } from '../types.js';
import { feeCurrencyOf } from './fee-asset.js';
import { isSubmittedFor } from './multisig.js';
import { chargesOperatorFee, fetchOperatorFee } from './operator-fee.js';
import type { PendingConfirmation } from './pending.js';
import {
  capturing,
  hasBlockHash,
  isHash,
  isPendingReceipt,
  isPreconfirmed,
  isReadable,
  isReceiptLag,
  isTimeout,
  RECEIPT_LAG_RETRY_MS,
  type ReplacementCapture,
  recheckReceipt,
  sameHex,
  sealedReceipt,
  toReceiptLike,
  unreadable,
  type ViemReceipt,
  withoutFees,
} from './receipt.js';
import { confirmKey, Recent } from './recent.js';
import { delay, durationOr, within } from './timing.js';

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
/** How long telemetry waits for the sealed receipt of a preconfirmed transaction before it records it without fees. */
const SEALED_RECEIPT_TIMEOUT_MS = 30_000;
/** How long telemetry waits for the OP Stack operator fee of a receipt before it records the receipt without it. */
const OPERATOR_FEE_TIMEOUT_MS = 10_000;
/** `error.type` of a confirm span whose transaction a chain reorganisation removed during a wait (ADR 0026). */
const NOT_ON_CHAIN = 'not_on_chain';
/**
 * Most receipt requests the follow of a multisig operation (`followMultisigOperations`) makes after a pending receipt
 * of a sync send, however long its timeout and however short the client's polling interval: its polls are spread over
 * the timeout (#402).
 */
export const MAX_PENDING_RECEIPT_REQUESTS = 60;
/** What core records for a pending receipt: no outcome; its other fields are not read. */
const PENDING_RECEIPT: ReceiptLike = { status: 'pending', blockNumber: 0, gasUsed: 0 };

/**
 * For a caller's wait with `confirmations` above 1: its receipt is read again once the wait resolved, for at most
 * `timeoutMs`, the wait's own timeout
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0026-receipt-after-several-confirmations.md).
 */
export interface RecheckOptions {
  timeoutMs: number;
}

/** What confirming needs from the `withHashspan()` call it belongs to. */
export interface ConfirmationOptions {
  /** The guarded tracker. */
  tracker: TxTracker;
  decodeRevertReason: boolean;
  revertReasonTimeoutMs: number;
  maxBackgroundConfirmations: number;
  /** Whether a multisig operation is followed to the transaction submitted for it (`followMultisigOperations`). */
  followMultisig: boolean;
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
    recheck?: RecheckOptions,
  ): Promise<void>;
  /**
   * Starts a confirm span for `hash` and polls for its receipt through `client`, off the caller's path. Returns false,
   * recording nothing and polling nothing, when `hash` is not a 32-byte hash or `maxBackgroundConfirmations` are
   * already polling.
   */
  confirmThrough(
    client: ViemClientLike,
    chainId: number,
    hash: string,
    timeoutMs: number,
    onReceipt?: (receipt: TransactionReceipt | undefined) => void,
  ): boolean;
  /**
   * With `followMultisigOperations`, after a sync send through `client` returned a pending receipt for the multisig
   * operation `hash` at `returnedAt`: opens its confirm span in `parent` at `startTime`, the call's start, and polls
   * for the submitted transaction's receipt off the caller's path, for at most `timeoutMs` and
   * {@link MAX_PENDING_RECEIPT_REQUESTS} requests, as one of the background confirmations. When
   * `maxBackgroundConfirmations` are already polling, nothing is followed: the span ends at `returnedAt` without an
   * outcome, as without the option.
   */
  confirmPending(
    client: ViemClientLike,
    chainId: number,
    hash: string,
    timeoutMs: number,
    call: { parent: Context; startTime: Date; returnedAt: Date },
  ): void;
}

export function createConfirmation({
  tracker,
  decodeRevertReason,
  revertReasonTimeoutMs,
  maxBackgroundConfirmations,
  followMultisig,
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

  /** Operator fees being or already read, keyed by transaction, block and gas used, so concurrent waits read once. */
  const operatorFees = new Recent<Promise<bigint | undefined>>();

  /**
   * The OP Stack operator fee of a sealed `receipt`, read through `client` once per transaction and block; undefined
   * when the receipt charges none (no request then), or when the call fails, answers with no `uint256` or takes longer
   * than `OPERATOR_FEE_TIMEOUT_MS`.
   */
  const operatorFeeOf = (
    chainId: number,
    receipt: ViemReceipt,
    client: unknown,
  ): Promise<bigint | undefined> | undefined => {
    if (!chargesOperatorFee(receipt) || typeof receipt.transactionHash !== 'string')
      return undefined;
    const key = `${confirmKey(chainId, receipt.transactionHash)}:${receipt.blockNumber}:${receipt.gasUsed}`;
    let fee = operatorFees.get(key);
    if (!fee) {
      const fetched = fetchOperatorFee(client, receipt).catch((error: unknown) => {
        diag.debug(`hashspan: could not read the operator fee (${errorName(error)})`);
        return undefined;
      });
      // Bounded, so that an unresponsive provider cannot keep the confirm span open.
      fee = within(fetched, OPERATOR_FEE_TIMEOUT_MS, 'read the operator fee');
      operatorFees.set(key, fee);
    }
    return fee;
  };

  /**
   * Ends `handle` from the outcome of `wait`; never rejects. The tracker joins handles for one transaction into one
   * confirm span
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0007-confirmation-ownership.md) and
   * attributes the receipt of a replacing transaction to that transaction
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0008-replaced-transactions.md). For
   * reverted receipts, the span ends after the revert reason was fetched with `client`. For a preconfirmed receipt, it
   * ends with the sealed receipt, read with `client` until `deadline` at the latest
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0024-sealed-receipt-fees.md). With
   * `recheck`, the receipt of the transaction itself is read again first, and the span records what the chain holds
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0026-receipt-after-several-confirmations.md).
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
    recheck?: RecheckOptions,
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
        else if (isTimeout(error)) handle.timeout({ endTime: endTimeOf() });
        else handle.fail(error, { endTime: endTimeOf() });
        return;
      }
      receipt = reported;
    }
    try {
      // A pending receipt is no outcome: it withdraws this wait (#402). Nothing is read for it, sealed or replayed.
      if (isPendingReceipt(receipt)) {
        handle.end(PENDING_RECEIPT, { endTime: endTimeOf() });
        return;
      }
      const { replacement } = capture;
      const reported =
        replacement !== undefined &&
        sameHex(replacement.transactionReceipt.transactionHash, receipt.transactionHash);
      const replacementReason = reported ? replacement.reason : undefined;
      // With `followMultisigOperations`, the receipt of the transaction a Tempo multisig relay submitted for the
      // awaited operation, which names the operation under `multisig`, is recorded for the awaited hash, not as a
      // replacement (#402).
      const submitted =
        followMultisig &&
        !reported &&
        !sameHex(receipt.transactionHash, hash) &&
        isSubmittedFor(receipt, hash);
      // A receipt of another hash belongs to this transaction only as a replacement viem reported, which it matches on
      // sender and nonce (docs/adr/0008-replaced-transactions.md). Otherwise the endpoint answered with an unrelated
      // transaction's receipt: none of its data is recorded, and the span ends as a failure.
      if (
        !reported &&
        !submitted &&
        typeof receipt.transactionHash === 'string' &&
        !sameHex(receipt.transactionHash, hash)
      ) {
        diag.debug(
          'hashspan: the wait resolved with the receipt of another transaction; not recording it',
        );
        handle.fail(undefined, unreadable(endTimeOf()));
        return;
      }
      // A replacing transaction pays its fee in what it names itself, never in what the replaced one named
      // (ADR 0028): a Celo fee currency is on the transaction viem reports, not on its receipt.
      const replacingAsset = reported ? feeCurrencyOf(replacement.transaction) : undefined;
      const normalise = (from: ViemReceipt): ReceiptLike => {
        const like = toReceiptLike(from);
        const attributed = submitted ? { ...like, transactionHash: hash } : like;
        return attributed.feeAsset === undefined && replacingAsset !== undefined
          ? { ...attributed, feeAsset: replacingAsset }
          : attributed;
      };
      let recorded = normalise(receipt);
      let endAt = endTimeOf;
      // A replacement keeps its own path (docs/adr/0008-replaced-transactions.md), and a preconfirmation the sealed
      // receipt's below: neither is read again.
      if (recheck && !reported && !isPreconfirmed(receipt) && hasBlockHash(receipt)) {
        // The span ends when the caller's wait resolved, not when the check finished.
        const resolvedAt = endTimeOf() ?? new Date();
        endAt = () => resolvedAt;
        // A flush that cannot wait records the caller's receipt.
        const kept = recorded;
        confirmation.onAbandon((underlying) => underlying.end(kept, { endTime: endAt() }));
        const found = await within(
          recheckReceipt(client, receipt),
          recheck.timeoutMs,
          'read the receipt again',
        );
        if (found?.kind === 'gone') {
          // The outcome on the chain is not known: no blockchain.tx.status (docs/adr/0016).
          handle.fail(undefined, { endTime: resolvedAt, errorType: NOT_ON_CHAIN });
          return;
        }
        if (found?.kind === 'moved') {
          receipt = found.receipt;
          recorded = normalise(found.receipt);
        }
      }
      if (isPreconfirmed(receipt)) {
        // The span ends when the receipt arrived, not when the sealed one was read, so its duration stays the wait's.
        const arrivedAt = endTimeOf() ?? new Date();
        endAt = () => arrivedAt;
        // Its fee may be another transaction's. A flush that cannot wait records it without fees.
        const preconfirmed = { ...withoutFees(recorded), replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(preconfirmed, { endTime: endAt() }));
        const sealed = await sealedReceipt(
          client,
          receipt,
          Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + SEALED_RECEIPT_TIMEOUT_MS),
        );
        if (sealed) {
          receipt = sealed;
          recorded = normalise(sealed);
        } else {
          diag.warn(
            'hashspan: no sealed receipt for a preconfirmed transaction; recording it without fees',
          );
          recorded = withoutFees(recorded);
        }
      }
      // Only from the sealed receipt, like the other fees (ADR 0024): a preconfirmation whose sealed receipt did not
      // come is recorded without fees above, and reads none.
      const operatorFee = isPreconfirmed(receipt)
        ? undefined
        : operatorFeeOf(chainId, receipt, client);
      if (operatorFee) {
        // The span ends when the receipt arrived, not when the operator fee was read.
        const arrivedAt = endAt() ?? new Date();
        endAt = () => arrivedAt;
        // A flush that cannot wait for the operator fee records the receipt without it.
        const known = { ...recorded, replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(known, { endTime: endAt() }));
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
          submitted ||
          (reported && sameHex(replacement.transaction.to, replacement.replacedTransaction.to))
            ? abis.get(confirmKey(chainId, hash))
            : undefined);
        // The receipt is known: a flush that cannot wait for the reason records the receipt without it.
        const mined = { ...recorded, replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(mined, { endTime: endAt() }));
        revertReason = await revertReasonOf(minedKey, receipt, abi, client);
      }
      if (operatorFee) {
        // The revert reason is known: a flush that cannot wait for the operator fee records the receipt with it.
        const withReason = { ...recorded, revertReason, replacementReason };
        confirmation.onAbandon((underlying) => underlying.end(withReason, { endTime: endAt() }));
        recorded = { ...recorded, operatorFee: await operatorFee };
      }
      handle.end({ ...recorded, revertReason, replacementReason }, { endTime: endAt() });
    } catch (error) {
      diag.error(`hashspan: failed to record receipt (${errorName(error)})`);
      handle.fail(error, { endTime: endTimeOf() });
    }
  };
  /**
   * Records the outcome of `wait` on `waitingHandle`; never rejects. Resolves as soon as the handle has ended,
   * including when a flush that gave up ended it
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0010-flush-before-shutdown.md), so the
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
    recheck?: RecheckOptions,
  ): Promise<void> => {
    const confirmation = settleOnce(waitingHandle);
    return Promise.race([
      recordReceipt(
        chainId,
        hash,
        confirmation,
        wait,
        capture,
        client,
        endTimeOf,
        deadline,
        recheck,
      ),
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

  /** Whether `maxBackgroundConfirmations` are already polling; warns once until the count falls below the limit. */
  const atLimit = (): boolean => {
    if (backgroundCount < maxBackgroundConfirmations) return false;
    if (!limitReported) {
      limitReported = true;
      diag.warn(
        `hashspan: ${maxBackgroundConfirmations} background confirmations are already polling; not confirming more until one ends (maxBackgroundConfirmations)`,
      );
    }
    return true;
  };
  /** Takes a slot of the background limit; the function returned gives it back. */
  const occupy = (): (() => void) => {
    backgroundCount++;
    return () => {
      backgroundCount--;
      if (backgroundCount < maxBackgroundConfirmations) limitReported = false;
    };
  };

  /**
   * Starts a confirm span for `hash` and polls for its receipt through `client`, off the caller's path. Returns false,
   * recording nothing and polling nothing, when `hash` is not a 32-byte hash or `maxBackgroundConfirmations` are
   * already polling.
   */
  const confirmThrough = (
    client: ViemClientLike,
    chainId: number,
    hash: string,
    timeoutMs: number,
    onReceipt?: (receipt: TransactionReceipt | undefined) => void,
  ): boolean => {
    // The tracker records nothing for another value (ADR 0025 rule 3): polling for it would only send requests until
    // the timeout, in a slot of the background limit.
    if (!isHash(hash)) {
      diag.debug('hashspan: not confirming a transaction without a valid hash');
      return false;
    }
    if (atLimit()) return false;
    // The poll below passes viem no count: it waits for one confirmation.
    const handle = tracker.startConfirm({ chainId, hash, confirmations: 1 });
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
    const release = occupy();
    const waited = wait();
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

  const confirmPending: Confirmation['confirmPending'] = (
    client,
    chainId,
    hash,
    timeoutMs,
    { parent, startTime, returnedAt },
  ) => {
    const handle = context.with(parent, () => tracker.startConfirm({ chainId, hash, startTime }));
    // The call is the caller's own wait, recorded as without the option; only the follow is over the limit (ADR 0018).
    if (atLimit()) {
      handle.end(PENDING_RECEIPT, { endTime: returnedAt });
      return;
    }
    const release = occupy();
    const waitMs = durationOr(timeoutMs, DEFAULT_BACKGROUND_TIMEOUT_MS);
    const deadline = Date.now() + waitMs;
    const polling = (client as { pollingInterval?: unknown }).pollingInterval;
    const intervalMs = Math.max(
      typeof polling === 'number' && polling > 0 ? polling : RECEIPT_LAG_RETRY_MS,
      waitMs / MAX_PENDING_RECEIPT_REQUESTS,
    );
    let ended = false;
    const wait = async (): Promise<ViemReceipt> => {
      for (let requests = 0; requests < MAX_PENDING_RECEIPT_REQUESTS; requests++) {
        const before = deadline - Date.now();
        if (before <= 0) break;
        await delay(Math.min(intervalMs, before));
        const remaining = deadline - Date.now();
        // A flush ended the span: no more requests.
        if (ended || remaining <= 0) break;
        // A missing receipt rejects, and a failed request too: both are polled again. Bounded by the deadline.
        const receipt = await within(
          viemGetTransactionReceipt(client as never, { hash: hash as `0x${string}` }),
          remaining,
          'read the receipt after a pending one',
        );
        if (receipt && !isPendingReceipt(receipt)) return receipt as ViemReceipt;
      }
      throw new WaitForTransactionReceiptTimeoutError({ hash: hash as `0x${string}` });
    };
    const waited = wait();
    waited.then(release, release);
    track(
      recordConfirmation(chainId, hash, handle, waited, {}, client, undefined, deadline).finally(
        () => {
          ended = true;
        },
      ),
    );
  };

  return { recordConfirmation, confirmThrough, confirmPending };
}
