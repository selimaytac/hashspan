// Validating what the tracker records: hashes, addresses and quantities from callers and remote parties.

export const TX_HASH: RegExp = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS: RegExp = /^0x[0-9a-fA-F]{40}$/;

/** The value of an own data property of `target`; undefined for an accessor, so no getter of the caller runs. */
export function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
/** A non-negative integer that fits in 256 bits. */
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
/** A `0x` hex quantity of at most 256 bits, as JSON-RPC encodes integers. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export function toInt(value: bigint | number): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`expected bigint or number, got ${typeof value}`);
}

/**
 * A non-negative integer of at most 256 bits, from a bigint, a safe integer, or a decimal or `0x` hex string, as
 * bundlers return them; undefined for anything else.
 */
export function quantity(value: unknown): bigint | undefined {
  let parsed: bigint | undefined;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && (AMOUNT.test(value) || HEX_QUANTITY.test(value))) {
    parsed = BigInt(value);
  }
  return parsed !== undefined && parsed >= 0n && parsed <= MAX_UINT256 ? parsed : undefined;
}

/** A quantity as a number, or undefined when it is none or too large to be one exactly. */
export function smallQuantity(value: unknown): number | undefined {
  const parsed = quantity(value);
  return parsed !== undefined && parsed <= MAX_SAFE_INTEGER ? Number(parsed) : undefined;
}

/** A decimal amount, or undefined when `value` is not a non-negative integer. */
export function amount(value: unknown): string | undefined {
  const text = typeof value === 'bigint' ? value.toString() : value;
  return typeof text === 'string' && AMOUNT.test(text) ? text : undefined;
}
