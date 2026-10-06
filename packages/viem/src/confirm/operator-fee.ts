// The OP Stack operator fee of a receipt (Isthmus and later), read from the GasPriceOracle predeploy.
import { encodeFunctionData } from 'viem';
import { call } from 'viem/actions';
import type { ViemReceipt } from './receipt.js';

/** The GasPriceOracle predeploy of every OP Stack chain. */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;

/** Only the function read here, so the adapter does not depend on the ABI of a newer viem. */
const GET_OPERATOR_FEE_ABI = [
  {
    type: 'function',
    name: 'getOperatorFee',
    stateMutability: 'view',
    inputs: [{ name: '_gasUsed', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** A `0x` hex quantity of at most 256 bits, as a node encodes the operator fee fields. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
/** One ABI-encoded `uint256`. */
const UINT256_WORD = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = 2n ** 256n - 1n;

/** `key` of `receipt` if it is an own data property; undefined otherwise, also when reading it throws. */
export function ownField(receipt: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(receipt, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** A non-negative quantity of at most 256 bits, from a hex string or a bigint; undefined for anything else. */
function quantityOf(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n && value <= MAX_UINT256 ? value : undefined;
  return typeof value === 'string' && HEX_QUANTITY.test(value) ? BigInt(value) : undefined;
}

/**
 * Whether `receipt` charges an OP Stack operator fee: after Isthmus, a node adds `operatorFeeScalar` and
 * `operatorFeeConstant` to a receipt when at least one of them is not zero, and viem passes them on unformatted.
 * A receipt without them, with malformed ones, or of a deposit transaction (which pays none) does not.
 */
export function chargesOperatorFee(receipt: ViemReceipt): boolean {
  if (receipt === null || typeof receipt !== 'object') return false;
  const type = ownField(receipt, 'type');
  if (type === 'deposit' || type === '0x7e') return false;
  const scalar = quantityOf(ownField(receipt, 'operatorFeeScalar'));
  const constant = quantityOf(ownField(receipt, 'operatorFeeConstant'));
  return (scalar !== undefined && scalar > 0n) || (constant !== undefined && constant > 0n);
}

/**
 * The operator fee of `receipt` in wei: one `eth_call` through `client` to `GasPriceOracle.getOperatorFee(gasUsed)`
 * at the receipt's block, which applies the formula of the upgrade active there. Rejects for a failed call or an
 * answer that is not one `uint256`.
 */
export async function fetchOperatorFee(client: unknown, receipt: ViemReceipt): Promise<bigint> {
  const { gasUsed, blockNumber } = receipt;
  if (typeof gasUsed !== 'bigint' || typeof blockNumber !== 'bigint' || gasUsed < 0n) {
    throw new TypeError('receipt gas used or block number is not a bigint');
  }
  const { data } = await call(client as never, {
    to: GAS_PRICE_ORACLE,
    data: encodeFunctionData({
      abi: GET_OPERATOR_FEE_ABI,
      functionName: 'getOperatorFee',
      args: [gasUsed],
    }),
    blockNumber,
  });
  if (typeof data !== 'string' || !UINT256_WORD.test(data)) {
    throw new TypeError('getOperatorFee did not answer with one uint256');
  }
  return BigInt(data);
}
