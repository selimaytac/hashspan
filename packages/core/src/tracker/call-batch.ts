// EIP-5792 call batches: send and confirm spans in a third key space (ADR 0022).
import {
  type Attributes,
  type Context,
  context,
  diag,
  SpanKind,
  type TimeInput,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_BLOCKCHAIN_BLOCK_NUMBER,
  ATTR_BLOCKCHAIN_CALL_BATCH_ATOMIC,
  ATTR_BLOCKCHAIN_CALL_BATCH_CALL_COUNT,
  ATTR_BLOCKCHAIN_CALL_BATCH_ID,
  ATTR_BLOCKCHAIN_CALL_BATCH_SENDER,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS,
  ATTR_BLOCKCHAIN_CALL_BATCH_STATUS_CODE,
  ATTR_BLOCKCHAIN_CALL_BATCH_TRANSACTION_HASHES,
  ATTR_BLOCKCHAIN_OPERATION_SUBJECT,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_SUCCESS,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_OPERATION_SUBJECT_VALUE_CALL_BATCH,
  ERROR_TYPE_VALUE_OTHER,
} from '../attributes.js';
import type { ConfirmRegistry, SharedConfirm } from '../confirm-registry.js';
import type { LinkStore } from '../link-store.js';
import { type TxMetrics, toEpochMs } from '../metrics.js';
import type {
  CallBatchConfirmHandle,
  CallBatchConfirmInput,
  CallBatchInput,
  CallBatchSendHandle,
  CallBatchStatusLike,
} from '../types.js';
import { joinConfirm } from './confirm-claim.js';
import {
  errorType,
  type HandleOptions,
  handleOptions,
  OBSERVER_TIMEOUT,
  reportedErrorType,
} from './handles.js';
import { metricAttributes, type SpanRecording, secondsSince } from './spans.js';
import { smallQuantity, TX_HASH } from './values.js';

/** `error.type` of a call batch that failed without being included (EIP-5792 status 400). */
const CALL_BATCH_FAILED = 'failed';
/** A call batch id: `0x`-prefixed hex of at most 8194 characters, the bound EIP-5792 sets. */
const CALL_BATCH_ID = /^0x[0-9a-fA-F]{1,8192}$/;
/** Longest call batch id recorded as an attribute. */
const MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH = 256;
/** Most transaction hashes recorded for one call batch. */
const MAX_CALL_BATCH_TRANSACTION_HASHES = 64;

/** EIP-5792 status code of a batch that is still pending. */
const CALL_BATCH_PENDING = 100;

export const noopCallBatchSend = (parent: Context): CallBatchSendHandle => ({
  context: parent,
  end: () => {},
  fail: () => {},
});
export const NOOP_CALL_BATCH_CONFIRM: CallBatchConfirmHandle = {
  end: () => {},
  timeout: () => {},
  fail: () => {},
};

/** The confirm span of one call batch and how to end it; shared by all its handles. */
export interface CallBatchConfirmSpan extends SharedConfirm {
  status(status: CallBatchStatusLike, endTime?: TimeInput): void;
  timeout(endTime?: TimeInput): void;
  fail(error: unknown, options: HandleOptions): void;
}

/** A call batch id the tracker keys and records. */
function isCallBatchId(id: unknown): id is string {
  return typeof id === 'string' && CALL_BATCH_ID.test(id);
}

/** Whether `status` says the batch is still pending: its wait resolved before an outcome. */
function isPendingCallBatch(status: CallBatchStatusLike | null | undefined): boolean {
  return status?.statusCode === CALL_BATCH_PENDING;
}

/** Metric attributes of a call batch sample. */
const callBatchMetricAttributes = (chainId: number, extra: Attributes = {}): Attributes =>
  metricAttributes(chainId, {
    [ATTR_BLOCKCHAIN_OPERATION_SUBJECT]: BLOCKCHAIN_OPERATION_SUBJECT_VALUE_CALL_BATCH,
    ...extra,
  });

/** What the call batch spans need from the `createTxTracker()` call. */
export interface CallBatchDependencies {
  links: LinkStore;
  callBatchLinks: LinkStore;
  callBatchConfirmations: ConfirmRegistry<CallBatchConfirmSpan>;
  txMetrics: TxMetrics;
  getTracer: () => Tracer;
  recording: SpanRecording;
}

/** The call batch methods of a tracker. */
export interface CallBatchSpans {
  startCallBatchSend(input: CallBatchInput, parentCtx?: Context): CallBatchSendHandle;
  startCallBatchConfirm(input: CallBatchConfirmInput, parentCtx?: Context): CallBatchConfirmHandle;
}

/** Creates the send and confirm spans of call batches for one tracker. */
export function createCallBatchSpans({
  links,
  callBatchLinks,
  callBatchConfirmations,
  txMetrics,
  getTracer,
  recording: { redact, markError, finisher, setRemoteAddress, baseAttributes },
}: CallBatchDependencies): CallBatchSpans {
  const startCallBatchSend = (input: CallBatchInput, parentCtx?: Context): CallBatchSendHandle => {
    const parent = parentCtx ?? context.active();
    const { chainId } = input;
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_CALL_BATCH_SENDER, input.sender);
    const callCount = smallQuantity(input.callCount);
    if (callCount !== undefined) attributes[ATTR_BLOCKCHAIN_CALL_BATCH_CALL_COUNT] = callCount;

    const span = getTracer().startSpan(
      `send ${chainId}`,
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
        callBatchMetricAttributes(
          chainId,
          errorType === undefined ? {} : { [ATTR_ERROR_TYPE]: errorType },
        ),
      );

    return {
      context: trace.setSpan(parent, span),
      end: (result, second) => {
        const { endTime } = handleOptions(second);
        finish(
          'record call batch id',
          () => {
            const id: unknown = result?.id;
            // The id comes from the wallet: validated before it is recorded or used as a key.
            if (!isCallBatchId(id)) {
              diag.debug('hashspan: ending a send span without a valid call batch id');
              return;
            }
            const sent = { spanContext: span.spanContext(), parent };
            callBatchLinks.set(chainId, id, sent);
            // Transactions the account sent itself for the batch are linked like those of a send span.
            const hashes: unknown = result.transactionHashes;
            if (Array.isArray(hashes)) {
              for (const hash of hashes) {
                if (typeof hash === 'string' && TX_HASH.test(hash) && !/^0x0+$/.test(hash)) {
                  links.set(chainId, hash, sent);
                }
              }
            }
            span.setAttributes(
              redact({
                [ATTR_BLOCKCHAIN_CALL_BATCH_ID]: id.slice(0, MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH),
              }),
            );
            recordSend(endTime);
          },
          endTime,
        );
      },
      fail: (error, second) => {
        const read = handleOptions(second);
        finish(
          'record call batch send failure',
          () =>
            recordSend(
              read.endTime,
              markError(span, reportedErrorType(error, read), error, errorType(error)),
            ),
          read.endTime,
        );
      },
    };
  };

  /** Attributes of a call batch status. Its values come from a wallet: what is malformed is left out. */
  const callBatchStatusAttributes = (status: CallBatchStatusLike): Attributes => {
    const attributes: Attributes = {};
    const code = smallQuantity(status.statusCode);
    if (code !== undefined) attributes[ATTR_BLOCKCHAIN_CALL_BATCH_STATUS_CODE] = code;
    const atomic: unknown = status.atomic;
    if (typeof atomic === 'boolean') attributes[ATTR_BLOCKCHAIN_CALL_BATCH_ATOMIC] = atomic;
    const receipts: unknown = status.receipts;
    if (Array.isArray(receipts)) {
      const hashes: string[] = [];
      const seen = new Set<string>();
      let block: number | undefined;
      for (const receipt of receipts) {
        const hash: unknown = receipt?.transactionHash;
        // Some wallets repeat one receipt per call: each transaction is recorded once, up to a bound.
        if (
          typeof hash === 'string' &&
          TX_HASH.test(hash) &&
          !seen.has(hash.toLowerCase()) &&
          hashes.length < MAX_CALL_BATCH_TRANSACTION_HASHES
        ) {
          seen.add(hash.toLowerCase());
          hashes.push(hash);
        }
        const number = smallQuantity(receipt?.blockNumber);
        if (number !== undefined && (block === undefined || number > block)) block = number;
      }
      if (hashes.length > 0) attributes[ATTR_BLOCKCHAIN_CALL_BATCH_TRANSACTION_HASHES] = hashes;
      if (block !== undefined) attributes[ATTR_BLOCKCHAIN_BLOCK_NUMBER] = block;
    }
    return attributes;
  };

  /**
   * The outcome of an EIP-5792 status code (ADR 0022): `blockchain.call_batch.status` for outcomes from chain data,
   * `error.type` for the rest; a code the spec does not define, or none, is `_OTHER`.
   */
  const callBatchOutcome = (code: unknown): { status?: string; errorType?: string } => {
    switch (code) {
      case 200:
        return { status: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_SUCCESS };
      case 400:
        return { errorType: CALL_BATCH_FAILED };
      case 500:
        return {
          status: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
          errorType: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED,
        };
      case 600:
        return {
          status: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
          errorType: BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED,
        };
      default:
        return { errorType: ERROR_TYPE_VALUE_OTHER };
    }
  };

  /** Opens the confirm span of a call batch. */
  const openCallBatchConfirm = (
    input: CallBatchConfirmInput,
    parentCtx?: Context,
  ): CallBatchConfirmSpan => {
    const { chainId, id } = input;
    const sent = callBatchLinks.get(chainId, id);
    const active = context.active();
    const parent = parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM, parent);
    attributes[ATTR_BLOCKCHAIN_CALL_BATCH_ID] = id.slice(0, MAX_CALL_BATCH_ID_ATTRIBUTE_LENGTH);
    const span = getTracer().startSpan(
      `confirm ${chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        links: sent ? [{ context: sent.spanContext }] : [],
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      },
      parent,
    );
    const finish = finisher(span);
    const startMs = toEpochMs(input.startTime);
    const recordConfirmation = (endTime: TimeInput | undefined, outcome: Attributes): void =>
      txMetrics.confirmationDuration(
        secondsSince(startMs, endTime),
        callBatchMetricAttributes(chainId, outcome),
      );

    return {
      active: 0,
      ended: false,
      status: (status, endTime) =>
        finish(
          'record call batch status',
          () => {
            const attributes = callBatchStatusAttributes(status ?? {});
            // A wait that resolved while the batch is pending has no outcome yet: no metric sample (ADR 0022).
            if (isPendingCallBatch(status)) {
              span.setAttributes(redact(attributes));
              return;
            }
            const outcome = callBatchOutcome(status?.statusCode);
            if (outcome.status !== undefined) {
              attributes[ATTR_BLOCKCHAIN_CALL_BATCH_STATUS] = outcome.status;
            }
            span.setAttributes(redact(attributes));
            if (outcome.errorType !== undefined) markError(span, outcome.errorType);
            // The outcome from chain data is the batch status; raw codes never become metric attributes. Batches
            // record no fee: wallet receipts lack the L1 fee and can be a bundle shared with others (ADR 0022).
            recordConfirmation(
              endTime,
              outcome.status !== undefined
                ? { [ATTR_BLOCKCHAIN_CALL_BATCH_STATUS]: outcome.status }
                : { [ATTR_ERROR_TYPE]: outcome.errorType },
            );
          },
          endTime,
        ),
      timeout: (endTime) =>
        finish(
          'record call batch confirmation timeout',
          () =>
            recordConfirmation(endTime, { [ATTR_ERROR_TYPE]: markError(span, OBSERVER_TIMEOUT) }),
          endTime,
        ),
      fail: (error, read) =>
        finish(
          'record call batch confirmation failure',
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
    };
  };

  const startCallBatchConfirm = (
    input: CallBatchConfirmInput,
    parentCtx?: Context,
  ): CallBatchConfirmHandle => {
    const { chainId, id } = input;
    if (!isCallBatchId(id)) {
      diag.debug('hashspan: not confirming a call batch without a valid id');
      return NOOP_CALL_BATCH_CONFIRM;
    }
    const claim = joinConfirm(callBatchConfirmations, chainId, id, () =>
      openCallBatchConfirm(input, parentCtx),
    );
    if (!claim) return NOOP_CALL_BATCH_CONFIRM;
    const { shared } = claim;
    return {
      end: (status, second) => {
        const { endTime } = handleOptions(second);
        // A pending result is an observer outcome, like a timeout: it withdraws this wait, and ends the span only as
        // the last one still waiting, releasing the key for a later wait (ADR 0007, ADR 0016).
        if (isPendingCallBatch(status)) {
          claim.withdraw(() => shared.status(status, endTime));
          return;
        }
        if (!claim.receive()) return;
        callBatchConfirmations.settle(chainId, id, shared);
        shared.status(status, endTime);
      },
      timeout: (second) => {
        const { endTime } = handleOptions(second);
        claim.withdraw(() => shared.timeout(endTime));
      },
      fail: (error, second) => {
        const read = handleOptions(second);
        claim.withdraw(() => shared.fail(error, read));
      },
    };
  };

  return { startCallBatchSend, startCallBatchConfirm };
}
