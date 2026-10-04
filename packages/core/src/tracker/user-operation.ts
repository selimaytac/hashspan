// User operations of smart accounts: send and confirm spans in their own key space (ADR 0021).
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
  ATTR_BLOCKCHAIN_OPERATION_SUBJECT,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_REVERT_REASON,
  ATTR_BLOCKCHAIN_USER_OPERATION_CALL_COUNT,
  ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT,
  ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST,
  ATTR_BLOCKCHAIN_USER_OPERATION_GAS_USED,
  ATTR_BLOCKCHAIN_USER_OPERATION_HASH,
  ATTR_BLOCKCHAIN_USER_OPERATION_NONCE,
  ATTR_BLOCKCHAIN_USER_OPERATION_PAYMASTER,
  ATTR_BLOCKCHAIN_USER_OPERATION_SENDER,
  ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_OPERATION_SUBJECT_VALUE_USER_OPERATION,
  BLOCKCHAIN_TX_STATUS_VALUE_REVERTED,
} from '../attributes.js';
import type { ConfirmRegistry, SharedConfirm } from '../confirm-registry.js';
import type { LinkStore } from '../link-store.js';
import { type TxMetrics, toEpochMs } from '../metrics.js';
import { type AddressFormatter, boundRevertReason } from '../privacy.js';
import type {
  UserOperationConfirmHandle,
  UserOperationConfirmInput,
  UserOperationInput,
  UserOperationReceiptLike,
  UserOperationSendHandle,
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
import { quantity, smallQuantity, TX_HASH } from './values.js';

const ZERO_ADDRESS = /^0x0{40}$/;

export const noopUserOperationSend = (parent: Context): UserOperationSendHandle => ({
  context: parent,
  end: () => {},
  fail: () => {},
});

export const NOOP_USER_OPERATION_CONFIRM: UserOperationConfirmHandle = {
  end: () => {},
  timeout: () => {},
  fail: () => {},
};

/** The confirm span of one user operation and how to end it; shared by all its handles. */
export interface UserOperationConfirmSpan extends SharedConfirm {
  receipt(receipt: UserOperationReceiptLike, endTime?: TimeInput): void;
  timeout(endTime?: TimeInput): void;
  fail(error: unknown, options: HandleOptions): void;
}

/** Metric attributes of a user operation sample: as for transactions, plus what the sample is about. */
const userOperationMetricAttributes = (chainId: number, extra: Attributes = {}): Attributes =>
  metricAttributes(chainId, {
    [ATTR_BLOCKCHAIN_OPERATION_SUBJECT]: BLOCKCHAIN_OPERATION_SUBJECT_VALUE_USER_OPERATION,
    ...extra,
  });

/** What the user operation spans need from the `createTxTracker()` call. */
export interface UserOperationDependencies {
  userOperationLinks: LinkStore;
  userOperationConfirmations: ConfirmRegistry<UserOperationConfirmSpan>;
  txMetrics: TxMetrics;
  formatAddress: AddressFormatter;
  getTracer: () => Tracer;
  recording: SpanRecording;
}

/** The user operation methods of a tracker. */
export interface UserOperationSpans {
  startUserOperationSend(input: UserOperationInput, parentCtx?: Context): UserOperationSendHandle;
  startUserOperationConfirm(
    input: UserOperationConfirmInput,
    parentCtx?: Context,
  ): UserOperationConfirmHandle;
}

/** Creates the send and confirm spans of user operations for one tracker. */
export function createUserOperationSpans({
  userOperationLinks,
  userOperationConfirmations,
  txMetrics,
  formatAddress,
  getTracer,
  recording: { redact, markError, finisher, setRemoteAddress, baseAttributes },
}: UserOperationDependencies): UserOperationSpans {
  const startUserOperationSend = (
    input: UserOperationInput,
    parentCtx?: Context,
  ): UserOperationSendHandle => {
    const parent = parentCtx ?? context.active();
    const { chainId } = input;
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_SENDER, input.sender);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT, input.entryPoint);
    const callCount = smallQuantity(input.callCount);
    if (callCount !== undefined) attributes[ATTR_BLOCKCHAIN_USER_OPERATION_CALL_COUNT] = callCount;

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
        userOperationMetricAttributes(
          chainId,
          errorType === undefined ? {} : { [ATTR_ERROR_TYPE]: errorType },
        ),
      );

    return {
      context: trace.setSpan(parent, span),
      end: (result, second) => {
        const { endTime } = handleOptions(second);
        finish(
          'record user operation hash',
          () => {
            const hash: unknown = result?.userOpHash;
            // The hash comes from the bundler: validated before it is recorded or used as a key.
            if (typeof hash !== 'string' || !TX_HASH.test(hash)) {
              diag.debug('hashspan: ending a send span without a valid user operation hash');
              return;
            }
            userOperationLinks.set(chainId, hash, { spanContext: span.spanContext(), parent });
            span.setAttributes(redact({ [ATTR_BLOCKCHAIN_USER_OPERATION_HASH]: hash }));
            recordSend(endTime);
          },
          endTime,
        );
      },
      fail: (error, second) => {
        const read = handleOptions(second);
        finish(
          'record user operation send failure',
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

  /**
   * Attributes of a user operation receipt. Its values come from a bundler: what is malformed is left out. The bundle
   * transaction's status, gas and fee are not recorded: they cover every operation in the bundle (ADR 0021).
   */
  const userOperationReceiptAttributes = (receipt: UserOperationReceiptLike): Attributes => {
    const attributes: Attributes = {};
    const success: unknown = receipt.success;
    if (typeof success === 'boolean') attributes[ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS] = success;
    const gasUsed = smallQuantity(receipt.actualGasUsed);
    if (gasUsed !== undefined) attributes[ATTR_BLOCKCHAIN_USER_OPERATION_GAS_USED] = gasUsed;
    const gasCost = quantity(receipt.actualGasCost);
    if (gasCost !== undefined) {
      attributes[ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST] = gasCost.toString();
    }
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_SENDER, receipt.sender);
    // 192-bit key and 64-bit sequence number: too large for an int attribute.
    const nonce = quantity(receipt.nonce);
    if (nonce !== undefined) attributes[ATTR_BLOCKCHAIN_USER_OPERATION_NONCE] = nonce.toString();
    const paymaster: unknown = receipt.paymaster;
    if (typeof paymaster === 'string' && !ZERO_ADDRESS.test(paymaster)) {
      setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_PAYMASTER, paymaster);
    }
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT, receipt.entryPoint);
    const reason: unknown = receipt.revertReason;
    if (typeof reason === 'string') {
      attributes[ATTR_BLOCKCHAIN_TX_REVERT_REASON] = boundRevertReason(reason, formatAddress);
    }
    const bundle: unknown = receipt.transactionHash;
    if (typeof bundle === 'string' && TX_HASH.test(bundle))
      attributes[ATTR_BLOCKCHAIN_TX_HASH] = bundle;
    const block = smallQuantity(receipt.blockNumber);
    if (block !== undefined) attributes[ATTR_BLOCKCHAIN_BLOCK_NUMBER] = block;
    return attributes;
  };

  /** Opens the confirm span of a user operation. */
  const openUserOperationConfirm = (
    input: UserOperationConfirmInput,
    parentCtx?: Context,
  ): UserOperationConfirmSpan => {
    const { chainId, userOpHash } = input;
    const sent = userOperationLinks.get(chainId, userOpHash);
    const active = context.active();
    const parent = parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM, parent);
    attributes[ATTR_BLOCKCHAIN_USER_OPERATION_HASH] = userOpHash;
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
        userOperationMetricAttributes(chainId, outcome),
      );

    return {
      active: 0,
      ended: false,
      receipt: (receipt, endTime) =>
        finish(
          'record user operation receipt',
          () => {
            const attributes = userOperationReceiptAttributes(receipt ?? {});
            span.setAttributes(redact(attributes));
            const success = attributes[ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS];
            if (success === false) markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
            // The outcome from chain data is the operation's success flag, not the bundle's status (ADR 0020).
            const outcome: Attributes =
              typeof success === 'boolean'
                ? { [ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS]: success }
                : {};
            recordConfirmation(endTime, outcome);
            const cost = attributes[ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST];
            if (typeof cost === 'string') {
              txMetrics.fee(BigInt(cost), userOperationMetricAttributes(chainId, outcome));
            }
          },
          endTime,
        ),
      timeout: (endTime) =>
        finish(
          'record user operation confirmation timeout',
          () =>
            recordConfirmation(endTime, { [ATTR_ERROR_TYPE]: markError(span, OBSERVER_TIMEOUT) }),
          endTime,
        ),
      fail: (error, read) =>
        finish(
          'record user operation confirmation failure',
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

  const startUserOperationConfirm = (
    input: UserOperationConfirmInput,
    parentCtx?: Context,
  ): UserOperationConfirmHandle => {
    const { chainId, userOpHash } = input;
    if (typeof userOpHash !== 'string' || !TX_HASH.test(userOpHash)) {
      diag.debug('hashspan: not confirming a user operation without a valid hash');
      return NOOP_USER_OPERATION_CONFIRM;
    }
    const claim = joinConfirm(userOperationConfirmations, chainId, userOpHash, () =>
      openUserOperationConfirm(input, parentCtx),
    );
    if (!claim) return NOOP_USER_OPERATION_CONFIRM;
    const { shared } = claim;
    return {
      end: (receipt, second) => {
        const { endTime } = handleOptions(second);
        if (!claim.receive()) return;
        userOperationConfirmations.settle(chainId, userOpHash, shared);
        shared.receipt(receipt, endTime);
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

  return { startUserOperationSend, startUserOperationConfirm };
}
