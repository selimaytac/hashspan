// A replacement viem did not report: after its wait timed out, the transaction with the same sender and nonce that
// was mined instead, found from what hashspan recorded when it sent the awaited one (ADR 0008 amendment).
import {
  getBlock as viemGetBlock,
  getBlockNumber as viemGetBlockNumber,
  getTransactionCount as viemGetTransactionCount,
  getTransactionReceipt as viemGetTransactionReceipt,
} from 'viem/actions';
import { own } from '../arguments.js';
import { sameHex, type ViemReceipt, type ViemReplacement } from './receipt.js';

/** The sender and nonce of a transaction hashspan sent, and its recipient, kept by hash for a while. */
export interface SentTransaction {
  from: string;
  nonce: number;
  to?: string | undefined;
}

/**
 * Most recent blocks searched for the block that took the nonce: about the state a full node keeps (128 blocks). The
 * search reads the sender's nonce at most `log2(MAX_REPLACEMENT_BLOCKS) + 2` times.
 */
export const MAX_REPLACEMENT_BLOCKS = 128;

/** The `SentTransaction` of a send, or undefined without a sender address or a nonce the caller passed. */
export function sentTransactionOf(
  from: unknown,
  nonce: unknown,
  to: unknown,
): SentTransaction | undefined {
  if (typeof from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(from)) return undefined;
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) return undefined;
  return { from, nonce, to: typeof to === 'string' ? to : undefined };
}

/**
 * Whether a wait may look for a replacement viem did not report: as viem decides its own `checkReplacement`, from the
 * wait's own data property, else the chain's `supportsTransactionReplacementDetection`, else true. False when either
 * is behind an accessor, which is never run. Never throws.
 */
export function detectsReplacement(args: unknown, client: unknown): boolean {
  try {
    if (args !== null && typeof args === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(args, 'checkReplacement');
      if (descriptor) return 'value' in descriptor && descriptor.value !== false;
    }
    const chain = own(client, 'chain');
    if (chain !== null && typeof chain === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(
        chain,
        'supportsTransactionReplacementDetection',
      );
      if (descriptor) return 'value' in descriptor && descriptor.value !== false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The transaction from `sent.from` with `sent.nonce` that was mined instead of `hash`, and its receipt, as viem would
 * have reported it, without a reason (the adapter infers none); undefined when `hash` has a receipt, the nonce is not
 * taken yet, it was taken before the last {@link MAX_REPLACEMENT_BLOCKS} blocks, or the block that took it holds no
 * other transaction with that nonce. At most `log2(MAX_REPLACEMENT_BLOCKS) + 6` requests. Rejects when a request
 * fails, other than the first.
 */
export async function findReplacement(
  client: unknown,
  hash: string,
  sent: SentTransaction,
): Promise<ViemReplacement | undefined> {
  const viemClient = client as never;
  const address = sent.from as `0x${string}`;
  const awaited = await viemGetTransactionReceipt(viemClient, {
    hash: hash as `0x${string}`,
  }).catch(() => undefined);
  // Mined after all: not a replacement. The timeout stands, as before.
  if (awaited) return undefined;
  const latest = await viemGetBlockNumber(viemClient, { cacheTime: 0 });
  const nonceAt = (blockNumber: bigint): Promise<number> =>
    viemGetTransactionCount(viemClient, { address, blockNumber });
  // The nonce after a block is the count of transactions the sender had mined by then.
  if ((await nonceAt(latest)) <= sent.nonce) return undefined;
  // Block -1 stands for the state before the first block, where no nonce is taken.
  let low = latest - BigInt(MAX_REPLACEMENT_BLOCKS);
  if (low < 0n) low = -1n;
  // Taken before the window: not searched.
  else if ((await nonceAt(low)) > sent.nonce) return undefined;
  // The first block after `low` whose state has the nonce taken, by binary search:
  // `nonceAt(low)` <= nonce < `nonceAt(high)`.
  let high = latest;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if ((await nonceAt(middle)) > sent.nonce) high = middle;
    else low = middle;
  }
  const block = await viemGetBlock(viemClient, { blockNumber: high, includeTransactions: true });
  const transactions = own(block, 'transactions');
  if (!Array.isArray(transactions)) return undefined;
  const transaction = (transactions as unknown[]).find(
    (candidate) =>
      sameHex(own(candidate, 'from'), sent.from) && own(candidate, 'nonce') === sent.nonce,
  );
  const minedHash = own(transaction, 'hash');
  if (typeof minedHash !== 'string' || sameHex(minedHash, hash)) return undefined;
  const transactionReceipt = (await viemGetTransactionReceipt(viemClient, {
    hash: minedHash as `0x${string}`,
  })) as unknown as ViemReceipt;
  if (!sameHex(transactionReceipt.transactionHash, minedHash)) return undefined;
  return {
    reason: undefined,
    replacedTransaction: { to: sent.to },
    transaction: transaction as ViemReplacement['transaction'],
    transactionReceipt,
  };
}
