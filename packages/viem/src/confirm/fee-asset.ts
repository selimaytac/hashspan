// The token a transaction's fee was paid in (ADR 0028): a Celo `feeCurrency`, a Tempo receipt's `feeToken`.
import { ownField } from './operator-fee.js';

/** The raw receipt type of a Tempo transaction, which viem's receipt formatter keeps as it is. */
export const TEMPO_TRANSACTION_TYPE = '0x76';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `value` lower-cased if it is a 20-byte `0x` hex address; undefined for anything else. */
export function feeAssetOf(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

/**
 * The `feeCurrency` a Celo transaction pays its fee in, read from an own data property of `transaction`, such as the
 * replacing transaction viem reports; undefined when there is none, also when reading it throws.
 */
export function feeCurrencyOf(transaction: unknown): string | undefined {
  if (transaction === null || typeof transaction !== 'object') return undefined;
  return feeAssetOf(ownField(transaction, 'feeCurrency'));
}

/**
 * The `feeToken` of a Tempo receipt, read from an own data property and only from a receipt whose raw type is
 * `0x76`, never by chain id: any other receipt gets none (fails closed).
 */
export function feeTokenOf(receipt: unknown): string | undefined {
  if (receipt === null || typeof receipt !== 'object') return undefined;
  if (ownField(receipt, 'type') !== TEMPO_TRANSACTION_TYPE) return undefined;
  return feeAssetOf(ownField(receipt, 'feeToken'));
}
