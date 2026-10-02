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
 * The user operation receipt for `userOpHash` in a node's raw receipt of its bundle transaction (`eth_getTransactionReceipt`):
 * the bundle's hash and block, and, when the bundle carries the operation's `UserOperationEvent`, its outcome and cost.
 * Only events whose `userOpHash` topic matches count, and whose `sender` topic matches `sender` when it is known. The
 * last matching log is used: the EntryPoint emits the event after the operation's calls ran, so a log the calls
 * emitted cannot come after it.
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
  for (let i = logs.length - 1; i >= 0; i--) {
    const log: unknown = logs[i];
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
    // Checksummed like the decoded sender and paymaster; nodes return log addresses in lower case.
    const address = own(log, 'address');
    const entryPoint =
      typeof address === 'string' && isAddress(address, { strict: false })
        ? getAddress(address)
        : undefined;
    return {
      ...bundle,
      success: args.success,
      actualGasCost: args.actualGasCost,
      actualGasUsed: args.actualGasUsed,
      sender: args.sender,
      nonce: args.nonce,
      paymaster: args.paymaster,
      entryPoint,
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
