// Validating what the tracker records: chain ids, hashes, addresses, quantities, names and identifiers from callers
// and remote parties (ADR 0025 rule 3). A value that fails is not recorded; none of these functions throws.

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

/** An EIP-155 chain id: a positive safe integer. */
export function isChainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Whether `value` is a 32-byte `0x` hex hash, in any letter case. */
export function isTxHash(value: unknown): value is string {
  return typeof value === 'string' && TX_HASH.test(value);
}

/** Whether `value` is a 20-byte `0x` hex address, in any letter case. */
export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value);
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

/**
 * A non-negative integer of at most 256 bits given as a bigint or a safe integer, as a transaction receipt holds them;
 * undefined for anything else, strings included.
 */
export function integer(value: unknown): bigint | undefined {
  return typeof value === 'bigint' || typeof value === 'number' ? quantity(value) : undefined;
}

/** {@link integer} as a number, or undefined when it is none or too large to be one exactly. */
export function smallInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed <= MAX_SAFE_INTEGER ? Number(parsed) : undefined;
}

/** `value` if it fits in 256 bits, as every amount on chain does; undefined for a larger one. */
export function uint256(value: bigint): bigint | undefined {
  return value >= 0n && value <= MAX_UINT256 ? value : undefined;
}

/** A non-negative safe integer given as a number, such as a nonce; undefined for anything else. */
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A decimal amount of at most 256 bits, from a bigint or a decimal string; undefined for anything else, a number
 * included, since a number may already have lost precision.
 */
export function amount(value: unknown): string | undefined {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !AMOUNT.test(text)) return undefined;
  return BigInt(text) <= MAX_UINT256 ? text : undefined;
}

/** A Solidity function name. */
const FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/;
/** A 4-byte function selector. */
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;

export function functionName(value: unknown): string | undefined {
  return typeof value === 'string' && FUNCTION_NAME.test(value) ? value : undefined;
}

export function functionSelector(value: unknown): string | undefined {
  return typeof value === 'string' && SELECTOR.test(value) ? value : undefined;
}

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * `value` if it is a short identifier, the only kind of free text recorded from a remote party, and the only form of
 * an error's name recorded as `error.type` or `exception.type`.
 */
export function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}
