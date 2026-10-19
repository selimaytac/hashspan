// Finding one user operation in its bundle transaction's receipt by the EntryPoint's `UserOperationEvent`
// (docs/adr/0031-watch-user-operation.md). The emitter rule is the one `@hashspan/cdp` uses (its
// `src/user-operation.ts`); `test/user-operation-event.test.ts` keeps the two copies equal.
import type { UserOperationReceiptLike } from '@hashspan/core';
import { decodeEventLog, getAddress, type Hex } from 'viem';
import { own } from '../arguments.js';
import { sameHex } from './receipt.js';

/**
 * The EntryPoint's event for each user operation it ran. Versions 0.6 to 0.9 emit it with the same signature, so
 * one decoder serves every version (ADR 0021).
 */
const USER_OPERATION_EVENT_ABI = [
  {
    type: 'event',
    name: 'UserOperationEvent',
    inputs: [
      { name: 'userOpHash', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'paymaster', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'success', type: 'bool', indexed: false },
      { name: 'actualGasCost', type: 'uint256', indexed: false },
      { name: 'actualGasUsed', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** `keccak256('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')`, the event's first topic. */
export const USER_OPERATION_EVENT_TOPIC =
  '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';

/** The canonical EntryPoint deployments, 0.6 to 0.9, in lower case, as `@hashspan/cdp` lists them. */
export const CANONICAL_ENTRY_POINTS: ReadonlySet<string> = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
  '0x433709009b8330fda32311df1c2afa402ed8d009',
]);

/**
 * Most logs of a bundle receipt read. A receipt with more is not matched at all: a match among the first logs could
 * have a second one past the bound (ADR 0025 rule 4).
 */
export const MAX_BUNDLE_LOGS = 10_000;

/** The data of a `UserOperationEvent`: four 32-byte words. */
const EVENT_DATA_LENGTH = 2 + 4 * 64;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;

/** `value` in lower case when it is an address; otherwise undefined. */
function lowerAddress(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

/** What identifies the operation in the bundle: its sender, and its nonce and hash when they are known. */
export interface BundleSearch {
  bundleHash: string;
  sender: string;
  nonce?: bigint | undefined;
  userOpHash?: string | undefined;
}

/** The outcome of a search: one operation with its receipt, or why none was chosen. */
export type BundleMatch =
  | { kind: 'one'; userOpHash: string; receipt: UserOperationReceiptLike }
  | { kind: 'none' | 'several' | 'too many logs' | 'other transaction' };

/**
 * The user operation of `search` in a node's raw receipt of its bundle transaction (`eth_getTransactionReceipt`).
 * Only an EntryPoint's events count: logs whose first topic is the `UserOperationEvent` signature, of the contract the
 * bundle transaction called (its `to`) or of a canonical EntryPoint ({@link CANONICAL_ENTRY_POINTS}). Of those, the
 * `sender` topic must match, and the nonce and the `userOpHash` topic when they are given. Exactly one such event is
 * a match; none or several are not. Reads own data properties only; may throw for a hostile receipt.
 */
export function findUserOperation(raw: unknown, search: BundleSearch): BundleMatch {
  if (!sameHex(own(raw, 'transactionHash'), search.bundleHash))
    return { kind: 'other transaction' };
  const logs = own(raw, 'logs');
  if (!Array.isArray(logs)) return { kind: 'none' };
  const length = own(logs, 'length');
  if (typeof length !== 'number') return { kind: 'none' };
  if (length > MAX_BUNDLE_LOGS) return { kind: 'too many logs' };
  const called = lowerAddress(own(raw, 'to'));
  const senderTopic = `0x${'0'.repeat(24)}${search.sender.slice(2)}`;
  let found: { userOpHash: string; receipt: UserOperationReceiptLike } | undefined;
  for (let index = 0; index < length; index++) {
    const log = own(logs, String(index));
    const address = lowerAddress(own(log, 'address'));
    if (address === undefined || (address !== called && !CANONICAL_ENTRY_POINTS.has(address)))
      continue;
    const topics = own(log, 'topics');
    if (!Array.isArray(topics) || own(topics, 'length') !== 4) continue;
    const [signature, hash, sender, paymaster] = [0, 1, 2, 3].map((i) => own(topics, String(i)));
    if (!sameHex(signature, USER_OPERATION_EVENT_TOPIC) || !sameHex(sender, senderTopic)) continue;
    if (search.userOpHash !== undefined && !sameHex(hash, search.userOpHash)) continue;
    const data = own(log, 'data');
    if (typeof data !== 'string' || data.length !== EVENT_DATA_LENGTH) continue;
    let args: ReturnType<typeof decodeEventLog<typeof USER_OPERATION_EVENT_ABI>>['args'];
    try {
      ({ args } = decodeEventLog({
        abi: USER_OPERATION_EVENT_ABI,
        topics: [signature, hash, sender, paymaster] as [Hex, ...Hex[]],
        data: data as Hex,
      }));
    } catch {
      // Malformed topics or data.
      continue;
    }
    if (search.nonce !== undefined && args.nonce !== search.nonce) continue;
    if (found) return { kind: 'several' };
    const block = own(raw, 'blockNumber');
    found = {
      userOpHash: args.userOpHash,
      receipt: {
        success: args.success,
        actualGasCost: args.actualGasCost,
        actualGasUsed: args.actualGasUsed,
        sender: args.sender,
        nonce: args.nonce,
        paymaster: args.paymaster,
        // Checksummed like the decoded sender and paymaster; nodes return log addresses in lower case.
        entryPoint: getAddress(address),
        transactionHash: search.bundleHash,
        blockNumber:
          typeof block === 'string' && block.length <= 66 && HEX.test(block)
            ? BigInt(block)
            : undefined,
      },
    };
  }
  return found ? { kind: 'one', ...found } : { kind: 'none' };
}
