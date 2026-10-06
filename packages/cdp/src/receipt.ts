// Receipts returned by the waits of network-scoped accounts, recorded without a reader.
import type { ReceiptLike } from '@hashspan/core';
import { diag } from '@opentelemetry/api';
import { stringOrUndefined } from './helpers.js';
import { own } from './own.js';

/**
 * Whether `value` is a preconfirmation: a flashblocks node (such as Base's) returns a receipt before its block is
 * sealed, with a zero or null block hash, and its `l1Fee` can be that of another transaction
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@1.1.0/docs/adr/0024-sealed-receipt-fees.md).
 */
function isPreconfirmed(value: object): boolean {
  const blockHash = own(value, 'blockHash');
  return blockHash === null || (typeof blockHash === 'string' && /^0x0*$/.test(blockHash));
}

/**
 * The fields of a viem receipt that the confirm span records, or undefined if `value` is not one. A preconfirmation's
 * fee fields are left out: the wait this records has no reader to read the sealed receipt with, and a fee that may be
 * another transaction's, or lacks its L1 part, would look valid (ADR 0024).
 */
export function receiptOf(value: unknown): ReceiptLike | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const status = own(value, 'status');
  const blockNumber = own(value, 'blockNumber');
  const gasUsed = own(value, 'gasUsed');
  if (status !== 'success' && status !== 'reverted') return undefined;
  if (typeof blockNumber !== 'bigint' || typeof gasUsed !== 'bigint') return undefined;
  const optional = (v: unknown) => (typeof v === 'bigint' ? v : undefined);
  const withFees = !isPreconfirmed(value);
  if (!withFees) {
    diag.debug('hashspan: the receipt is a preconfirmation; recording it without fees');
  }
  return {
    status,
    blockNumber,
    gasUsed,
    effectiveGasPrice: withFees ? optional(own(value, 'effectiveGasPrice')) : undefined,
    l1Fee: withFees ? optional(own(value, 'l1Fee')) : undefined,
    transactionHash: stringOrUndefined(own(value, 'transactionHash')),
  };
}
