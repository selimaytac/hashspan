// Following a Tempo multisig operation, with the `followMultisigOperations` option (#402). A multisig relay
// (`Relay.multisig` of `viem/tempo`) answers a sync send whose approvals are below quorum with a pending receipt that
// carries the operation's hash, and receipt lookups of that hash with nothing until it submits the transaction, then
// with the submitted transaction's receipt, which names the operation under `multisig`. Every field is read from own
// data properties only.
import { TEMPO_TRANSACTION_TYPE } from './fee-asset.js';
import { ownField } from './operator-fee.js';

/** A 32-byte hash. */
const HASH = /^0x[0-9a-fA-F]{64}$/;

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
