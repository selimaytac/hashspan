// Tempo multisig operations (#402). A multisig relay (`Relay.multisig` of `viem/tempo`) answers a sync send whose
// approvals are below quorum with a pending receipt that carries the operation's hash, and receipt lookups of that
// hash with nothing until it submits the transaction, then with the submitted transaction's receipt, which names the
// operation under `multisig`. Every field is read from own data properties only.
import { TEMPO_TRANSACTION_TYPE } from './fee-asset.js';
import { ownField } from './operator-fee.js';

/** A 32-byte hash. */
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Whether `receipt` is a pending receipt of a Tempo transaction: a 32-byte `transactionHash`, no block number, and
 * either the status `pending` and type `tempo` that viem's Tempo formatter gives it, or no status and the raw type
 * `0x76`, as viem's own formatter leaves it. Any other receipt is not (fails closed).
 */
export function isPendingReceipt(receipt: unknown): boolean {
  if (receipt === null || typeof receipt !== 'object') return false;
  const hash = ownField(receipt, 'transactionHash');
  if (typeof hash !== 'string' || !HASH.test(hash)) return false;
  const blockNumber = ownField(receipt, 'blockNumber');
  if (blockNumber !== null && blockNumber !== undefined) return false;
  const status = ownField(receipt, 'status');
  const type = ownField(receipt, 'type');
  return (
    (status === 'pending' && (type === 'tempo' || type === TEMPO_TRANSACTION_TYPE)) ||
    ((status === undefined || status === null) && type === TEMPO_TRANSACTION_TYPE)
  );
}

/**
 * Whether `receipt` is the receipt of the transaction a multisig relay submitted for the operation `hash`: of type
 * `0x76`, with a `multisig` object whose `hash` is a 32-byte hash equal to `hash`, without letter case.
 */
export function isSubmittedFor(receipt: unknown, hash: string): boolean {
  if (receipt === null || typeof receipt !== 'object') return false;
  if (ownField(receipt, 'type') !== TEMPO_TRANSACTION_TYPE) return false;
  const operation = ownField(receipt, 'multisig');
  if (operation === null || typeof operation !== 'object') return false;
  const operationHash = ownField(operation, 'hash');
  return (
    typeof operationHash === 'string' &&
    HASH.test(operationHash) &&
    operationHash.toLowerCase() === hash.toLowerCase()
  );
}
