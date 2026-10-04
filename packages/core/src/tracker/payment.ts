// Payments that another party settles on chain (ADR 0013, ADR 0017).
import {
  type Attributes,
  type Context,
  context,
  diag,
  SpanKind,
  type Tracer,
} from '@opentelemetry/api';
import {
  ATTR_BLOCKCHAIN_PAYMENT_AMOUNT,
  ATTR_BLOCKCHAIN_PAYMENT_ASSET,
  ATTR_BLOCKCHAIN_PAYMENT_PAYER,
  ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL,
  ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT,
  ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT,
  ATTR_BLOCKCHAIN_PAYMENT_STATUS,
  ATTR_BLOCKCHAIN_PAYMENT_VERIFIED,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_X402_RESOURCE,
  ATTR_X402_SCHEME,
  BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR,
  BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED,
  ERROR_TYPE_VALUE_OTHER,
} from '../attributes.js';
import type { LinkStore } from '../link-store.js';
import { type AddressFormatter, formatAddressesIn, paymentResourceOf } from '../privacy.js';
import type {
  PaymentHandle,
  PaymentInput,
  PaymentResourceMode,
  PaymentSettlement,
} from '../types.js';
import {
  errorType,
  handleOptions,
  OBSERVER_TIMEOUT,
  reportedErrorType,
  safely,
} from './handles.js';
import type { SpanRecording } from './spans.js';
import { ADDRESS, amount, identifier, TX_HASH } from './values.js';

const PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING,
  BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED,
]);

export const NOOP_PAYMENT: PaymentHandle = {
  end: () => {},
  fail: () => {},
  timeout: () => {},
  link: () => {},
};

/** What the payment spans need from the `createTxTracker()` call. */
export interface PaymentDependencies {
  links: LinkStore;
  formatAddress: AddressFormatter;
  paymentResource: PaymentResourceMode;
  getTracer: () => Tracer;
  recording: SpanRecording;
}

/** The payment method of a tracker. */
export interface PaymentSpans {
  startPayment(input: PaymentInput, parentCtx?: Context): PaymentHandle;
}

/** Creates the payment spans for one tracker. */
export function createPaymentSpans({
  links,
  formatAddress,
  paymentResource,
  getTracer,
  recording: { redact, markError, finisher, setRemoteAddress, baseAttributes },
}: PaymentDependencies): PaymentSpans {
  const startPayment = (input: PaymentInput, parentCtx?: Context): PaymentHandle => {
    const parent = parentCtx ?? context.active();
    const attributes = baseAttributes(
      input.chainId,
      BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT,
      parent,
    );
    const protocol = identifier(input.protocol);
    if (protocol !== undefined) attributes[ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL] = protocol;
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_PAYER, input.payer);
    const knownPayer = typeof input.payer === 'string' && ADDRESS.test(input.payer);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT, input.recipient);
    setRemoteAddress(attributes, ATTR_BLOCKCHAIN_PAYMENT_ASSET, input.asset);
    const paid = amount(input.amount);
    if (paid !== undefined) attributes[ATTR_BLOCKCHAIN_PAYMENT_AMOUNT] = paid;
    const scheme = identifier(input.x402?.scheme);
    if (scheme !== undefined) attributes[ATTR_X402_SCHEME] = scheme;
    const resource = input.x402?.resource;
    const recorded =
      typeof resource === 'string' ? paymentResourceOf(resource, paymentResource) : undefined;
    if (recorded) attributes[ATTR_X402_RESOURCE] = formatAddressesIn(recorded, formatAddress);

    const span = getTracer().startSpan(
      `payment ${input.chainId}`,
      {
        kind: SpanKind.CLIENT,
        attributes: redact(attributes),
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      },
      parent,
    );
    const finish = finisher(span);

    /** Links the confirm span of `hash` to this payment span, unless the tracker already links that hash. */
    const linkHash = (hash: unknown): hash is string => {
      if (typeof hash !== 'string' || !TX_HASH.test(hash)) return false;
      // A hash this tracker already links, such as one of its own sends, keeps that link.
      if (!links.get(input.chainId, hash)) {
        // The facilitator sends the settlement transaction and pays its fee.
        links.set(input.chainId, hash, {
          spanContext: span.spanContext(),
          parent,
          feePayer: BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR,
        });
      }
      return true;
    };

    const recordSettlement = (settlement: PaymentSettlement): void => {
      const status = settlement.status;
      if (!PAYMENT_STATUSES.has(status)) {
        diag.debug('hashspan: ignoring a payment settlement with an unknown status');
        return;
      }
      // The settlement comes from the settling party, which the payer does not control: it never replaces what the
      // payer knew itself (docs/adr/0013-x402-payments.md).
      const settled: Attributes = { [ATTR_BLOCKCHAIN_PAYMENT_STATUS]: status };
      const hash: unknown = settlement.hash;
      if (linkHash(hash)) {
        settled[ATTR_BLOCKCHAIN_TX_HASH] = hash;
      }
      if (!knownPayer) setRemoteAddress(settled, ATTR_BLOCKCHAIN_PAYMENT_PAYER, settlement.payer);
      // Recorded as reported, next to the amount the payer knew, which it never replaces.
      const settledAmount = amount(settlement.amount);
      if (settledAmount !== undefined) {
        settled[ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT] = settledAmount;
        if (paid === undefined) settled[ATTR_BLOCKCHAIN_PAYMENT_AMOUNT] = settledAmount;
      }
      const verified: unknown = settlement.verified;
      if (typeof verified === 'boolean') settled[ATTR_BLOCKCHAIN_PAYMENT_VERIFIED] = verified;
      span.setAttributes(redact(settled));
      if (status === BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED) {
        markError(span, identifier(settlement.errorReason) ?? ERROR_TYPE_VALUE_OTHER);
      }
    };

    return {
      end: (settlement, options) =>
        finish(
          'record payment settlement',
          () => recordSettlement(settlement),
          handleOptions(options).endTime,
        ),
      fail: (error, options) => {
        const read = handleOptions(options);
        finish(
          'record payment failure',
          () => markError(span, reportedErrorType(error, read), error, errorType(error)),
          read.endTime,
        );
      },
      timeout: (options) =>
        finish(
          'record payment timeout',
          () => markError(span, OBSERVER_TIMEOUT),
          handleOptions(options).endTime,
        ),
      link: (hash) => safely('link the payment span', () => void linkHash(hash), undefined),
    };
  };

  return { startPayment };
}
