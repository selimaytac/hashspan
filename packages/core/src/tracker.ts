import {
  type Attributes,
  type Context,
  context,
  diag,
  type Link,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { agentAttributes } from './agent.js';
import {
  ATTR_BLOCKCHAIN_BLOCK_NUMBER,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME,
  ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_SYSTEM,
  ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE,
  ATTR_BLOCKCHAIN_TX_FEE,
  ATTR_BLOCKCHAIN_TX_FROM,
  ATTR_BLOCKCHAIN_TX_GAS_USED,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_L1_FEE,
  ATTR_BLOCKCHAIN_TX_NONCE,
  ATTR_BLOCKCHAIN_TX_REVERT_REASON,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_BLOCKCHAIN_TX_TO,
  ATTR_BLOCKCHAIN_TX_VALUE,
  ATTR_ERROR_TYPE,
  BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
  BLOCKCHAIN_OPERATION_NAME_VALUE_SEND,
  BLOCKCHAIN_SYSTEM_VALUE_EVM,
  BLOCKCHAIN_TX_STATUS_VALUE_REVERTED,
  BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
  BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT,
  ERROR_TYPE_VALUE_OTHER,
} from './attributes.js';
import { LinkStore } from './link-store.js';
import { type AddressFormatter, resolveAddressFormatter } from './privacy.js';
import type {
  ConfirmHandle,
  ConfirmInput,
  ReceiptLike,
  SendHandle,
  SendInput,
  TxTrackerOptions,
} from './types.js';
import { VERSION } from './version.js';

const INSTRUMENTATION_NAME = '@hashspan/core';
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 10_000;

/** Attributes kept when the redaction hook fails (fail closed). */
const NON_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  ATTR_BLOCKCHAIN_SYSTEM,
  ATTR_BLOCKCHAIN_CHAIN_ID,
  ATTR_BLOCKCHAIN_OPERATION_NAME,
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_STATUS,
  ATTR_ERROR_TYPE,
]);

export interface TxTracker {
  /**
   * Starts a `send` span as a child of `parent` (default: the active context).
   * Call `end(hash)` once the transaction hash is known, or `fail(error)`.
   */
  startSend(input: SendInput, parent?: Context): SendHandle;
  /**
   * Starts a `confirm` span for a transaction, linked to its `send` span when known.
   * Parent: `parent` if given, else the active span, else the `send` span's parent.
   */
  startConfirm(input: ConfirmInput, parent?: Context): ConfirmHandle;
}

const NOOP_SEND: SendHandle = { end: () => {}, fail: () => {} };
const NOOP_CONFIRM: ConfirmHandle = { end: () => {}, timeout: () => {}, fail: () => {} };

/** Runs `fn`, logging instead of throwing: instrumentation must never break the caller. */
function safely<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    diag.error(`hashspan: failed to ${what}`, error);
    return fallback;
  }
}

function toInt(value: bigint | number): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`expected bigint or number, got ${typeof value}`);
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : ERROR_TYPE_VALUE_OTHER;
}

function markError(span: Span, type: string, error?: unknown): void {
  if (error !== undefined) {
    span.recordException(error instanceof Error ? error : String(error));
  }
  span.setAttribute(ATTR_ERROR_TYPE, type);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(error instanceof Error ? { message: error.message } : {}),
  });
}

export function createTxTracker(options: TxTrackerOptions = {}): TxTracker {
  const links = new LinkStore({
    ttlMs: options.linkTtlMs ?? DEFAULT_LINK_TTL_MS,
    maxEntries: options.maxTrackedTransactions ?? DEFAULT_MAX_TRACKED,
  });
  const formatAddress: AddressFormatter = safely(
    'configure address mode',
    () => resolveAddressFormatter(options.address),
    () => undefined,
  );
  let tracer: Tracer | undefined;
  const getTracer = (): Tracer => {
    tracer ??= (options.tracerProvider ?? trace.getTracerProvider()).getTracer(
      INSTRUMENTATION_NAME,
      VERSION,
    );
    return tracer;
  };

  const redact = (attributes: Attributes): Attributes => {
    if (!options.redact) return attributes;
    try {
      return options.redact({ ...attributes });
    } catch (error) {
      diag.error('hashspan: redaction hook failed; recording non-sensitive attributes only', error);
      return Object.fromEntries(
        Object.entries(attributes).filter(([key]) => NON_SENSITIVE_KEYS.has(key)),
      );
    }
  };

  const setAddress = (attributes: Attributes, key: string, address: string | undefined): void => {
    if (address === undefined) return;
    const formatted = formatAddress(address);
    if (formatted !== undefined) attributes[key] = formatted;
  };

  const baseAttributes = (chainId: number, operation: string, ctx: Context): Attributes => ({
    [ATTR_BLOCKCHAIN_SYSTEM]: BLOCKCHAIN_SYSTEM_VALUE_EVM,
    [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId,
    [ATTR_BLOCKCHAIN_OPERATION_NAME]: operation,
    ...agentAttributes(ctx, options.agent),
  });

  const startSend = (input: SendInput, parentCtx?: Context): SendHandle => {
    const parent = parentCtx ?? context.active();
    const attributes = baseAttributes(input.chainId, BLOCKCHAIN_OPERATION_NAME_VALUE_SEND, parent);
    setAddress(attributes, ATTR_BLOCKCHAIN_TX_FROM, input.from);
    setAddress(attributes, ATTR_BLOCKCHAIN_TX_TO, input.to);
    if (input.value !== undefined) attributes[ATTR_BLOCKCHAIN_TX_VALUE] = input.value.toString();
    if (input.nonce !== undefined) attributes[ATTR_BLOCKCHAIN_TX_NONCE] = input.nonce;
    if (input.functionName !== undefined) {
      attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME] = input.functionName;
    }
    if (input.functionSelector !== undefined) {
      attributes[ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR] = input.functionSelector;
    }

    const span = getTracer().startSpan(
      `send ${input.chainId}`,
      { kind: SpanKind.CLIENT, attributes: redact(attributes) },
      parent,
    );
    let ended = false;

    return {
      end: (hash) =>
        safely(
          'end send span',
          () => {
            if (ended) return;
            ended = true;
            span.setAttributes(redact({ [ATTR_BLOCKCHAIN_TX_HASH]: hash }));
            links.set(input.chainId, hash, { spanContext: span.spanContext(), parent });
            span.end();
          },
          undefined,
        ),
      fail: (error) =>
        safely(
          'end send span',
          () => {
            if (ended) return;
            ended = true;
            markError(span, errorType(error), error);
            span.end();
          },
          undefined,
        ),
    };
  };

  const receiptAttributes = (receipt: ReceiptLike): Attributes => {
    const attributes: Attributes = {
      [ATTR_BLOCKCHAIN_TX_STATUS]:
        receipt.status === 'reverted'
          ? BLOCKCHAIN_TX_STATUS_VALUE_REVERTED
          : BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
      [ATTR_BLOCKCHAIN_BLOCK_NUMBER]: toInt(receipt.blockNumber),
      [ATTR_BLOCKCHAIN_TX_GAS_USED]: toInt(receipt.gasUsed),
    };
    const l1Fee = receipt.l1Fee ?? undefined;
    if (l1Fee !== undefined) attributes[ATTR_BLOCKCHAIN_TX_L1_FEE] = l1Fee.toString();
    if (receipt.effectiveGasPrice !== undefined) {
      attributes[ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE] = receipt.effectiveGasPrice.toString();
      const executionFee = BigInt(receipt.gasUsed) * receipt.effectiveGasPrice;
      attributes[ATTR_BLOCKCHAIN_TX_FEE] = (executionFee + (l1Fee ?? 0n)).toString();
    }
    if (receipt.revertReason !== undefined) {
      attributes[ATTR_BLOCKCHAIN_TX_REVERT_REASON] = receipt.revertReason;
    }
    return attributes;
  };

  const startConfirm = (input: ConfirmInput, parentCtx?: Context): ConfirmHandle => {
    const sent = links.get(input.chainId, input.hash);
    const active = context.active();
    const parent = parentCtx ?? (trace.getSpan(active) ? active : (sent?.parent ?? active));
    const attributes = baseAttributes(
      input.chainId,
      BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM,
      parent,
    );
    attributes[ATTR_BLOCKCHAIN_TX_HASH] = input.hash;
    const spanLinks: Link[] = sent ? [{ context: sent.spanContext }] : [];

    const span = getTracer().startSpan(
      `confirm ${input.chainId}`,
      { kind: SpanKind.CLIENT, attributes: redact(attributes), links: spanLinks },
      parent,
    );
    let ended = false;
    const finish = (what: string, record: () => void): void => {
      if (ended) return;
      ended = true;
      try {
        record();
      } catch (error) {
        diag.error(`hashspan: failed to ${what}`, error);
      } finally {
        span.end();
      }
    };

    return {
      end: (receipt) =>
        finish('record receipt', () => {
          span.setAttributes(redact(receiptAttributes(receipt)));
          if (receipt.status === 'reverted') markError(span, BLOCKCHAIN_TX_STATUS_VALUE_REVERTED);
        }),
      timeout: () =>
        finish('record confirmation timeout', () => {
          span.setAttributes(
            redact({ [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT }),
          );
          markError(span, BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT);
        }),
      fail: (error) =>
        finish('record confirmation failure', () => markError(span, errorType(error), error)),
    };
  };

  return {
    startSend: (input, parent) =>
      safely('start send span', () => startSend(input, parent), NOOP_SEND),
    startConfirm: (input, parent) =>
      safely('start confirm span', () => startConfirm(input, parent), NOOP_CONFIRM),
  };
}
