// Receipts and rejections as viem returns them, normalised for the core.
import {
  ERROR_TYPE_VALUE_OTHER,
  type ReceiptLike,
  type ReplacementReason,
  type UserOperationReceiptLike,
} from '@hashspan/core';
import { diag, type TimeInput } from '@opentelemetry/api';
import { getTransactionReceipt as viemGetTransactionReceipt } from 'viem/actions';
import { formatRevertData } from '../revert-reason.js';
import { errorName } from '../safe-tracker.js';
import { delay } from './timing.js';

/** What viem passes to `onReplaced`. */
export interface ViemReplacement {
  reason: ReplacementReason;
  replacedTransaction: { to?: string | null | undefined };
  transaction: { to?: string | null | undefined };
  transactionReceipt: ViemReceipt;
}

/** The replacement viem reported to one wait, if any. */
export interface ReplacementCapture {
  replacement?: ViemReplacement | undefined;
}

/**
 * `onReplaced` for a wait: stores the replacement first, then calls the caller's callback with the same argument.
 * What the callback throws still rejects the wait, as in plain viem.
 */
export function capturing(
  capture: ReplacementCapture,
  onReplaced: ((replacement: ViemReplacement) => void) | undefined,
): (replacement: ViemReplacement) => void {
  return (replacement) => {
    capture.replacement = replacement;
    onReplaced?.(replacement);
  };
}

/** Case-insensitive equality of two hex strings (addresses or hashes); false unless both are strings. */
export function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export interface ViemReceipt {
  transactionHash: `0x${string}`;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint | undefined;
  l1Fee?: bigint | string | null | undefined;
  blockHash?: string | null | undefined;
}

/**
 * Whether `receipt` is a preconfirmation: a flashblocks node returns a receipt before its block is sealed, with a zero
 * (or null) block hash, and its `l1Fee` can be that of another transaction. Fees are recorded from the sealed receipt
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.11.0/docs/adr/0024-sealed-receipt-fees.md).
 */
export function isPreconfirmed(receipt: ViemReceipt): boolean {
  const { blockHash } = receipt;
  return blockHash === null || (typeof blockHash === 'string' && /^0x0*$/.test(blockHash));
}

/** `receipt` without the fields that make up its fee, for a preconfirmed receipt whose sealed one never came. */
export function withoutFees(receipt: ReceiptLike): ReceiptLike {
  return { ...receipt, effectiveGasPrice: undefined, l1Fee: undefined };
}

/**
 * The `name` of `error` if it is an Error with a string name; undefined otherwise, also when reading it throws (a
 * throwing getter or Proxy trap), so classifying a rejection never throws.
 */
export function nameOf(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const name: unknown = error.name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether telemetry can read `error`: core records an Error's name as `error.type`. A rejection whose name cannot be
 * read is recorded without the error, as `error.type` `_OTHER`, so its confirm span still ends.
 */
export function isReadable(error: unknown): boolean {
  try {
    if (error instanceof Error) void error.name;
    return true;
  } catch {
    return false;
  }
}

/** `fail()` options for a rejection that cannot be read: no error object, `error.type` `_OTHER`. */
export function unreadable(endTime: TimeInput | undefined): {
  endTime?: TimeInput;
  errorType: string;
} {
  return endTime === undefined
    ? { errorType: ERROR_TYPE_VALUE_OTHER }
    : { endTime, errorType: ERROR_TYPE_VALUE_OTHER };
}

export function isCallsTimeout(error: unknown): boolean {
  return nameOf(error) === 'WaitForCallsStatusTimeoutError';
}

export function isTimeout(error: unknown): boolean {
  return nameOf(error) === 'WaitForTransactionReceiptTimeoutError';
}

/** viem gives up waiting for a user operation receipt with this error, on its timeout or after `retryCount` polls. */
export function isUserOperationTimeout(error: unknown): boolean {
  return nameOf(error) === 'WaitForUserOperationReceiptTimeoutError';
}

/** What viem's `waitForUserOperationReceipt` returns, as far as the adapter reads it. */
export interface ViemUserOperationReceipt {
  success?: unknown;
  actualGasCost?: unknown;
  actualGasUsed?: unknown;
  sender?: unknown;
  nonce?: unknown;
  paymaster?: unknown;
  entryPoint?: unknown;
  reason?: unknown;
  receipt?: { transactionHash?: unknown; blockNumber?: unknown } | undefined;
}

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * Normalises viem's user operation receipt. The core checks every value, since they come from the bundler. viem
 * types `nonce` as a bigint but passes on the bundler's hex string; the core accepts both. `reason` is the revert
 * data of the operation's call, decoded like a transaction's (without an ABI, a custom error is its selector).
 */
export function toUserOperationReceiptLike(
  receipt: ViemUserOperationReceipt,
): UserOperationReceiptLike {
  const { reason } = receipt;
  const bundle = receipt.receipt;
  return {
    success: receipt.success as boolean | undefined,
    actualGasCost: receipt.actualGasCost as bigint | undefined,
    actualGasUsed: receipt.actualGasUsed as bigint | undefined,
    sender: receipt.sender as string | undefined,
    nonce: receipt.nonce as bigint | string | undefined,
    paymaster: receipt.paymaster as string | undefined,
    entryPoint: receipt.entryPoint as string | undefined,
    revertReason:
      receipt.success === false && typeof reason === 'string' && HEX_DATA.test(reason)
        ? formatRevertData(reason as `0x${string}`, undefined)
        : undefined,
    transactionHash: bundle?.transactionHash as string | undefined,
    blockNumber: bundle?.blockNumber as bigint | undefined,
  };
}

/**
 * viem gives up waiting when a node returns a mined transaction before its receipt: it looks for a replacement,
 * finds the transaction itself in the block and fails to fetch its receipt again. Background confirmation waits
 * again after these errors, as after a failed request, until its timeout.
 */
export function isReceiptLag(error: unknown): boolean {
  const name = nameOf(error);
  return name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError';
}
/** How long background confirmation waits before it polls again, for a client without a polling interval. */
export const RECEIPT_LAG_RETRY_MS = 1_000;

/**
 * The sealed receipt of the preconfirmed `receipt`, read through `client` until `deadline`; undefined if none came.
 * Never rejects: a missing receipt, a failed request or another preconfirmation is retried.
 */
export async function sealedReceipt(
  client: unknown,
  receipt: ViemReceipt,
  deadline: number,
): Promise<ViemReceipt | undefined> {
  const polling = (client as { pollingInterval?: unknown } | null)?.pollingInterval;
  const retryMs = typeof polling === 'number' && polling > 0 ? polling : RECEIPT_LAG_RETRY_MS;
  for (;;) {
    try {
      const sealed = (await viemGetTransactionReceipt(client as never, {
        hash: receipt.transactionHash,
      })) as ViemReceipt;
      if (!isPreconfirmed(sealed)) return sealed;
    } catch (error) {
      diag.debug(`hashspan: the sealed receipt is not available yet (${errorName(error)})`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await delay(Math.min(retryMs, remaining));
  }
}

/** A `0x` hex quantity of at most 256 bits, as a node encodes `l1Fee`. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Normalises a viem receipt; `l1Fee` is a bigint with the OP-stack formatter, else a raw hex string. An `l1Fee` that
 * is not a hex quantity is passed on as given: the core then records neither it nor the total fee, and the rest of
 * the receipt as usual (ADR 0025 rule 3).
 */
export function toReceiptLike(receipt: ViemReceipt): ReceiptLike {
  const { l1Fee } = receipt;
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    l1Fee: typeof l1Fee === 'string' && HEX_QUANTITY.test(l1Fee) ? BigInt(l1Fee) : (l1Fee as never),
    transactionHash: receipt.transactionHash,
  };
}
