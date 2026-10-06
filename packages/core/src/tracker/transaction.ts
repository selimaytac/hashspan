// Transactions: send and confirm spans, replaced transactions (ADR 0008), fees, EIP-7702 authorizations.
import {
  type Attributes,
  type Context,
  context,
  diag,
  type Link,
  SpanKind,
  type TimeInput,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_BLOCKCHAIN_BLOCK_NUMBER,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR,
  ATTR_BLOCKCHAIN_FEE_PAYER,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS,
  ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT,
  ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE,
  ATTR_BLOCKCHAIN_TX_FEE,
  ATTR_BLOCKCHAIN_TX_FROM,
  ATTR_BLOCKCHAIN_TX_GAS_USED,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_L1_FEE,
  ATTR_BLOCKCHAIN_TX_NONCE,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH,
  ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON,
  ATTR_BLOCKCHAIN_TX_REVERT_REASON,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_TX_TO,
  ATTR_BLOCKCHAIN_TX_VALUE,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_CANCELLED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPLACED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPRICED,
  BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
  BLOCKCHAIN_TX_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
  ERROR_TYPE_VALUE_OTHER,
} from '../attributes.js';
import type { ConfirmRegistry, SharedConfirm } from '../confirm-registry.js';
import type { LinkStore, SentTransaction } from '../link-store.js';
import { type TxMetrics, toEpochMs } from '../metrics.js';
import {
  type AddressFormatter,
  boundRevertReason,
  serializeFunctionArguments,
} from '../privacy.js';
import type {
  ConfirmHandle,
  ConfirmInput,
  EndOptions,
  FailOptions,
  ReceiptLike,
  ReplacementReason,
  SendHandle,
  SendInput,
  SendResult,
  TxTrackerOptions,
} from '../types.js';
import { joinConfirm } from './confirm-claim.js';
import {
  errorType,
  type HandleOptions,
  handleOptions,
  NOOP_CONFIRM,
  OBSERVER_TIMEOUT,
  reportedErrorType,
  safely,
} from './handles.js';
import { metricAttributes, type SpanRecording, secondsSince } from './spans.js';
import {
  amount,
  count,
  functionName,
  functionSelector,
  integer,
  isAddress,
  isTxHash,
  ownValue,
  smallInteger,
  uint256,
} from './values.js';

/** Most EIP-7702 authorizations listed on a send span; the count covers all of them. */
const MAX_AUTHORIZATIONS = 64;

/** The receipt statuses of the `ReceiptLike` type and what each records as `blockchain.tx.status`. */
const RECEIPT_STATUSES: ReadonlyMap<unknown, string> = new Map([
  ['success', BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS],
  ['reverted', BLOCKCHAIN_TX_STATUS_VALUE_REVERTED],
]);

const REPLACEMENT_REASONS: ReadonlySet<string> = new Set([
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPRICED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_CANCELLED,
  BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPLACED,
]);

/** The confirm span of one transaction and how to end it; shared by all its handles. */
export interface ConfirmSpan extends SharedConfirm {
  /**
   * What a confirm span of a replacing transaction inherits from this one
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@1.0.0/docs/adr/0008-replaced-transactions.md).
   */
  origin: ConfirmOrigin;
  receipt(receipt: ReceiptLike, endTime?: TimeInput): void;
  timeout(endTime?: TimeInput): void;
  fail(error: unknown, options: HandleOptions): void;
  /** Ends as replaced by the transaction `hash`. */
  replaced(hash: string, reason: ReplacementReason | undefined, endTime?: TimeInput): void;
  /** Ends as a failure without any receipt data, for a receipt that cannot be attributed. */
  unattributable(endTime?: TimeInput): void;
}

interface ConfirmOrigin {
  parent: Context;
  startTime: TimeInput;
  links: Link[];
  /** Who pays the fee when it is not the sender; the replacing transaction's fee is paid by the same party. */
  feePayer: SentTransaction['feePayer'];
}

/** What the transaction spans need from the `createTxTracker()` call. */
export interface TransactionDependencies {
  options: TxTrackerOptions;
  links: LinkStore;
  confirmations: ConfirmRegistry<ConfirmSpan>;
  txMetrics: TxMetrics;
  formatAddress: AddressFormatter;
  getTracer: () => Tracer;
  recording: SpanRecording;
}

/** The transaction methods of a tracker. */
export interface TransactionSpans {
  startSend(input: SendInput, parentCtx?: Context): SendHandle;
  startConfirm(input: ConfirmInput, parentCtx?: Context): ConfirmHandle;
}

/** Creates the send and confirm spans of transactions for one tracker. */
export function createTransactionSpans({
  options,
  links,
  confirmations,
  txMetrics,
  formatAddress,
  getTracer,
  recording: { redact, markError, finisher, setAddress, baseAttributes },
}: TransactionDependencies): TransactionSpans {
  /**
   * Records an EIP-7702 authorization list: its length, and for each well-formed entry (an address and a non-negative
   * integer chain id, read from own data properties only) its address per the address mode and its chain id, at most
   * {@link MAX_AUTHORIZATIONS}. The two lists stay aligned: an entry is listed in both or in neither.
   */
  const setAuthorizations = (attributes: Attributes, list: unknown): void => {
    if (!Array.isArray(list) || list.length === 0) return;
    attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT] = list.length;
    const addresses: string[] = [];
    const chainIds: number[] = [];
    for (const entry of list.slice(0, MAX_AUTHORIZATIONS)) {
      const address = ownValue(entry, 'address');
      const chainId = ownValue(entry, 'chainId');
      if (!isAddress(address)) continue;
      if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 0) continue;
      const formatted = formatAddress(address);
      if (formatted !== undefined) addresses.push(formatted);
      chainIds.push(chainId);
    }
    if (addresses.length > 0) attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES] = addresses;
    if (chainIds.length > 0) attributes[ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS] = chainIds;
  };

  const startSend = (input: SendInput, parentCtx?: Context): SendHandle => {
    const parent = parentCtx ?? context.active();
    const attributes = baseAttributes(input.chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    // What the caller passes is validated like what a remote party returns (ADR 0025 rule 3).
    if (isAddress(input.from)) setAddress(attributes, ATTR_BLOCKCHAIN_TX_FROM, input.from);
    if (isAddress(input.to)) setAddress(attributes, ATTR_BLOCKCHAIN_TX_TO, input.to);
    const value = amount(input.value);
    if (value !== undefined) attributes[ATTR_BLOCKCHAIN_TX_VALUE] = value;
    const nonce = count(input.nonce);
    if (nonce !== undefined) attributes[ATTR_BLOCKCHAIN_TX_NONCE] = nonce;
    try {
      setAuthorizations(attributes, input.authorizations);
    } catch (error) {
      diag.debug(`hashspan: could not record authorizations (${errorType(error)})`);
    }
    const name = functionName(input.functionName);
    if (name !== undefined) attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME] = name;
    const selector = functionSelector(input.functionSelector);
    if (selector !== undefined) attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR] = selector;
    if (options.recordFunctionArguments === true && input.functionArguments !== undefined) {
      try {
        attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS] = serializeFunctionArguments(
          input.functionArguments,
          formatAddress,
        );
      } catch (error) {
        diag.debug(`hashspan: could not serialize function arguments (${errorType(error)})`);
      }
    }

    const span = getTracer().startSpan(
      `send ${input.chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      },
      parent,
    );
    const finish = finisher(span);
    const startMs = toEpochMs(input.startTime);
    const recordSend = (endTime: TimeInput | undefined, errorType?: string): void =>
      txMetrics.sendDuration(
        secondsSince(startMs, endTime),
        metricAttributes(
          input.chainId,
          errorType === undefined ? {} : { [ATTR_ERROR_TYPE]: errorType },
        ),
      );

    return {
      context: trace.setSpan(parent, span),
      end: (result: SendResult, second?: EndOptions): void => {
        const { endTime } = handleOptions(second);
        finish(
          'record transaction hash',
          () => {
            const hash: unknown = result?.hash;
            if (!isTxHash(hash)) {
              diag.debug('hashspan: ending a send span without a valid transaction hash');
              return;
            }
            links.set(input.chainId, hash, { spanContext: span.spanContext(), parent });
            span.setAttributes(redact({ [ATTR_BLOCKCHAIN_TX_HASH]: hash }));
            recordSend(endTime);
          },
          endTime,
        );
      },
      fail: (error: unknown, second?: FailOptions): void => {
        const options = handleOptions(second);
        finish(
          'record send failure',
          () =>
            recordSend(
              options.endTime,
              markError(span, reportedErrorType(error, options), error, errorType(error)),
            ),
          options.endTime,
        );
      },
    };
  };

  /**
   * Attributes of a receipt. Its quantities come from a node: one that is not a non-negative integer is not recorded,
   * and the fee only when every part of it is known (ADR 0025 rule 3).
   */
  const receiptAttributes = (receipt: ReceiptLike): Attributes => {
    const block = smallInteger(receipt.blockNumber);
    const gasUsed = smallInteger(receipt.gasUsed);
    // Both are required: a receipt without them cannot be read, and records nothing.
    if (block === undefined || gasUsed === undefined) {
      throw new TypeError('receipt block number or gas used is not a non-negative safe integer');
    }
    const attributes: Attributes = {
      [ATTR_BLOCKCHAIN_BLOCK_NUMBER]: block,
      [ATTR_BLOCKCHAIN_TX_GAS_USED]: gasUsed,
    };
    // A status other than the two a receipt can have is not recorded as either (ADR 0025 rule 3).
    const status = RECEIPT_STATUSES.get(receipt.status);
    if (status !== undefined) attributes[ATTR_BLOCKCHAIN_TX_STATUS] = status;
    const givenL1Fee: unknown = receipt.l1Fee ?? undefined;
    const l1Fee = integer(givenL1Fee);
    if (l1Fee !== undefined) attributes[ATTR_BLOCKCHAIN_TX_L1_FEE] = l1Fee.toString();
    const givenGasPrice: unknown = receipt.effectiveGasPrice;
    const gasPrice = integer(givenGasPrice);
    if (gasPrice !== undefined) {
      attributes[ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE] = gasPrice.toString();
      // A fee without its L1 part, or without the gas used, would be a wrong value, not a bounded one.
      const fee =
        givenL1Fee === undefined || l1Fee !== undefined
          ? uint256(BigInt(gasUsed) * gasPrice + (l1Fee ?? 0n))
          : undefined;
      if (fee !== undefined) attributes[ATTR_BLOCKCHAIN_TX_FEE] = fee.toString();
    }
    if (typeof receipt.revertReason === 'string') {
      attributes[ATTR_BLOCKCHAIN_TX_REVERT_REASON] = boundRevertReason(
        receipt.revertReason,
        formatAddress,
      );
    }
    return attributes;
  };

  /** Opens the confirm span of a transaction; `replacing` is the confirm span of the transaction it replaced. */
  const openConfirm = (
    input: ConfirmInput,
    parentCtx?: Context,
    replacing?: ConfirmOrigin,
  ): ConfirmSpan => {
    const sent = links.get(input.chainId, input.hash);
    const feePayer = replacing ? replacing.feePayer : sent?.feePayer;
    const active = context.active();
    const parent =
      replacing?.parent ?? parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(
      input.chainId,
      BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
      parent,
    );
    attributes[ATTR_BLOCKCHAIN_TX_HASH] = input.hash;
    const spanLinks: Link[] = [
      ...(replacing?.links ?? []),
      ...(sent ? [{ context: sent.spanContext }] : []),
    ];
    // Only spans recorded after the fact get an explicit start time (a replacing transaction's, or one an adapter
    // records late): with one, the SDK measures the end time with the wall clock instead of the monotonic clock.
    const explicitStart = input.startTime ?? replacing?.startTime;

    const span = getTracer().startSpan(
      `confirm ${input.chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        links: spanLinks,
        ...(explicitStart !== undefined ? { startTime: explicitStart } : {}),
      },
      parent,
    );
    const finish = finisher(span);
    const startMs = toEpochMs(explicitStart);
    const recordConfirmation = (endTime: TimeInput | undefined, outcome: Attributes): void =>
      txMetrics.confirmationDuration(
        secondsSince(startMs, endTime),
        metricAttributes(input.chainId, outcome),
      );
    const origin: ConfirmOrigin = {
      parent,
      startTime: explicitStart ?? new Date(),
      links: [{ context: span.spanContext() }, ...(sent ? [{ context: sent.spanContext }] : [])],
      feePayer,
    };

    return {
      active: 0,
      ended: false,
      origin,
      receipt: (receipt, endTime) =>
        finish(
          'record receipt',
          () => {
            const attributes = receiptAttributes(receipt);
            span.setAttributes(redact(attributes));
            const recorded = attributes[ATTR_BLOCKCHAIN_TX_STATUS];
            // A receipt without a known status says nothing about the transaction's outcome: `_OTHER`, no fee sample.
            if (recorded === undefined) {
              recordConfirmation(endTime, {
                [ATTR_ERROR_TYPE]: markError(span, ERROR_TYPE_VALUE_OTHER),
              });
              return;
            }
            if (recorded === BLOCKCHAIN_TX_STATUS_VALUE_REVERTED) {
              markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
            }
            const status = { [ATTR_BLOCKCHAIN_TX_STATUS]: recorded };
            recordConfirmation(endTime, status);
            const fee = attributes[ATTR_BLOCKCHAIN_TX_FEE];
            if (typeof fee === 'string')
              txMetrics.fee(
                BigInt(fee),
                metricAttributes(
                  input.chainId,
                  feePayer ? { ...status, [ATTR_BLOCKCHAIN_FEE_PAYER]: feePayer } : status,
                ),
              );
          },
          endTime,
        ),
      // Giving up describes the observer, not the transaction: no blockchain.tx.status (docs/adr/0016).
      timeout: (endTime) =>
        finish(
          'record confirmation timeout',
          () =>
            recordConfirmation(endTime, { [ATTR_ERROR_TYPE]: markError(span, OBSERVER_TIMEOUT) }),
          endTime,
        ),
      fail: (error, read) =>
        finish(
          'record confirmation failure',
          () =>
            recordConfirmation(read.endTime, {
              [ATTR_ERROR_TYPE]: markError(
                span,
                reportedErrorType(error, read),
                error,
                errorType(error),
              ),
            }),
          read.endTime,
        ),
      replaced: (hash, reason, endTime) =>
        finish(
          'record replacement',
          () => {
            const attributes: Attributes = {
              [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
              [ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH]: hash,
            };
            if (reason !== undefined && REPLACEMENT_REASONS.has(reason)) {
              attributes[ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON] = reason;
            }
            span.setAttributes(redact(attributes));
            recordConfirmation(endTime, {
              [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
            });
          },
          endTime,
        ),
      unattributable: (endTime) =>
        finish(
          'record unattributable receipt',
          () =>
            recordConfirmation(endTime, {
              [ATTR_ERROR_TYPE]: markError(span, ERROR_TYPE_VALUE_OTHER),
            }),
          endTime,
        ),
    };
  };

  /**
   * Records `receipt` for the replacing transaction `hash`: ends its in-flight confirm span, does nothing if it
   * already settled, and otherwise opens one that inherits parent, start time and links from `original`.
   */
  const recordReplacing = (
    chainId: number,
    hash: string,
    receipt: ReceiptLike,
    original: ConfirmOrigin,
    endTime: TimeInput | undefined,
  ): void => {
    const current = confirmations.get(chainId, hash);
    if (current === 'settled' || current?.ended) return;
    const confirm = current ?? openConfirm({ chainId, hash }, undefined, original);
    if (!current) confirmations.start(chainId, hash, confirm);
    confirm.ended = true;
    confirmations.settle(chainId, hash, confirm);
    const { replacementReason: _reason, ...mined } = receipt;
    confirm.receipt(mined, endTime);
  };

  /**
   * Ends `shared` with `receipt`, attributing it to the transaction that was mined
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@1.0.0/docs/adr/0008-replaced-transactions.md).
   */
  const endWithReceipt = (
    chainId: number,
    hash: string,
    shared: ConfirmSpan,
    receipt: ReceiptLike,
    endTime: TimeInput | undefined,
  ): void => {
    // A receipt without a readable block number and gas used cannot be recorded: it ends the span as a failure and
    // releases the key for a later wait, as one with an invalid hash does (#311).
    if (
      smallInteger(receipt.blockNumber) === undefined ||
      smallInteger(receipt.gasUsed) === undefined
    ) {
      diag.warn('hashspan: receipt without a readable block number or gas used; not recording it');
      confirmations.release(chainId, hash, shared);
      shared.unattributable(endTime);
      return;
    }
    const mined: unknown = receipt.transactionHash;
    if (mined === undefined) {
      confirmations.settle(chainId, hash, shared);
      shared.receipt(receipt, endTime);
      return;
    }
    // Validated before it is compared or used as a registry key.
    if (!isTxHash(mined)) {
      diag.warn('hashspan: receipt has an invalid transaction hash; not recording it');
      confirmations.release(chainId, hash, shared);
      shared.unattributable(endTime);
      return;
    }
    if (mined.toLowerCase() === hash.toLowerCase()) {
      confirmations.settle(chainId, hash, shared);
      shared.receipt(receipt, endTime);
      return;
    }
    confirmations.settle(chainId, hash, shared);
    shared.replaced(mined, receipt.replacementReason, endTime);
    safely(
      'record replacing transaction',
      () => recordReplacing(chainId, mined, receipt, shared.origin, endTime),
      undefined,
    );
  };

  /**
   * Joins the confirm span of the transaction, opening it for the first handle. A receipt from any handle ends the
   * span; a timeout or failure only ends it when it is the last handle still waiting.
   */
  const startConfirm = (input: ConfirmInput, parentCtx?: Context): ConfirmHandle => {
    const { chainId, hash } = input;
    // The hash keys the shared span: one that is not a hash records nothing.
    if (!isTxHash(hash)) {
      diag.debug('hashspan: not confirming a transaction without a valid hash');
      return NOOP_CONFIRM;
    }
    const claim = joinConfirm(confirmations, chainId, hash, () => openConfirm(input, parentCtx));
    if (!claim) return NOOP_CONFIRM;
    const { shared } = claim;
    return {
      end: (receipt: ReceiptLike, second?: EndOptions): void => {
        const { endTime } = handleOptions(second);
        if (!claim.receive()) return;
        try {
          endWithReceipt(chainId, hash, shared, receipt, endTime);
        } catch {
          // A receipt that cannot be read still ends the span, as `_OTHER`, and releases the key for a later wait
          // (ADR 0025 rule 1). Neither call does anything if the span already ended or the key was settled.
          diag.debug('hashspan: could not read a receipt; ending the confirm span without it');
          safely(
            'release receipt key',
            () => confirmations.release(chainId, hash, shared),
            undefined,
          );
          shared.unattributable(endTime);
        }
      },
      timeout: (second?: EndOptions): void => {
        const { endTime } = handleOptions(second);
        claim.withdraw(() => shared.timeout(endTime));
      },
      fail: (error: unknown, second?: FailOptions): void => {
        const read = handleOptions(second);
        claim.withdraw(() => shared.fail(error, read));
      },
    };
  };

  return { startSend, startConfirm };
}
