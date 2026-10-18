import type { UserOperationReceiptLike } from '@hashspan/core';
import { decodeEventLog, getAddress, type Hex, isAddress } from 'viem';
import { own } from './own.js';

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

const HEX = /^0x[0-9a-fA-F]+$/;

function sameHex(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * The canonical EntryPoint deployments, 0.6 to 0.9, in lower case. `test/sdk-drift.test.ts` checks that viem lists
 * no other.
 */
export const CANONICAL_ENTRY_POINTS: ReadonlySet<string> = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
  '0x433709009b8330fda32311df1c2afa402ed8d009',
]);

/** `value` in lower case when it is an address; otherwise undefined. */
function lowerAddress(value: unknown): string | undefined {
  return typeof value === 'string' && isAddress(value, { strict: false })
    ? value.toLowerCase()
    : undefined;
}

/**
 * The user operation receipt for `userOpHash` in a node's raw receipt of its bundle transaction (`eth_getTransactionReceipt`):
 * the bundle's hash and block, and, when the bundle carries the operation's `UserOperationEvent`, its outcome and cost.
 * Only an EntryPoint's events count: logs of the contract the bundle transaction called (its `to`), or of a canonical
 * EntryPoint ({@link CANONICAL_ENTRY_POINTS}). Of those, only events whose `userOpHash` topic matches count, and whose
 * `sender` topic matches `sender` when it is known; the last one is used.
 */
export function userOperationReceiptFromBundle(
  raw: unknown,
  userOpHash: string,
  sender: string | undefined,
): UserOperationReceiptLike {
  const transactionHash = own(raw, 'transactionHash');
  const block = own(raw, 'blockNumber');
  const bundle: UserOperationReceiptLike = {
    transactionHash: typeof transactionHash === 'string' ? transactionHash : undefined,
    blockNumber: typeof block === 'string' && HEX.test(block) ? BigInt(block) : undefined,
  };
  const logs = own(raw, 'logs');
  if (!Array.isArray(logs)) return bundle;
  const called = lowerAddress(own(raw, 'to'));
  for (let i = logs.length - 1; i >= 0; i--) {
    const log: unknown = logs[i];
    const address = lowerAddress(own(log, 'address'));
    if (address === undefined || (address !== called && !CANONICAL_ENTRY_POINTS.has(address)))
      continue;
    const topics = own(log, 'topics');
    if (!Array.isArray(topics) || !sameHex(topics[1], userOpHash)) continue;
    let event: ReturnType<typeof decodeEventLog<typeof USER_OPERATION_EVENT_ABI>>;
    try {
      event = decodeEventLog({
        abi: USER_OPERATION_EVENT_ABI,
        topics: topics as [Hex, ...Hex[]],
        data: own(log, 'data') as Hex,
      });
    } catch {
      // Another event with the hash as its first topic, or malformed data.
      continue;
    }
    const { args } = event;
    if (sender !== undefined && !sameHex(args.sender, sender)) continue;
    return {
      ...bundle,
      success: args.success,
      actualGasCost: args.actualGasCost,
      actualGasUsed: args.actualGasUsed,
      sender: args.sender,
      nonce: args.nonce,
      paymaster: args.paymaster,
      // Checksummed like the decoded sender and paymaster; nodes return log addresses in lower case.
      entryPoint: getAddress(address),
    };
  }
  return bundle;
}

/** Remembers the chain and sender of the user operations sent, so that a wait, which names neither, can be traced. */
export class SentUserOperations {
  readonly #entries = new Map<string, { chainId: number; sender: string | undefined }>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  add(userOpHash: string, chainId: number, sender: string | undefined): void {
    const key = userOpHash.toLowerCase();
    this.#entries.delete(key);
    this.#entries.set(key, { chainId, sender });
    // The oldest entry goes first: a wait usually follows its send closely.
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }

  get(userOpHash: string): { chainId: number; sender: string | undefined } | undefined {
    return this.#entries.get(userOpHash.toLowerCase());
  }
}
