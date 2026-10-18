// A replacement viem did not report: after its wait timed out, the transaction with the same sender and nonce that
// was mined instead, found from what hashspan learned when it sent the awaited one (ADR 0008 amendment).
import { diag } from '@opentelemetry/api';
import { hexToNumber, numberToHex } from 'viem';
import {
  getBlock as viemGetBlock,
  getBlockNumber as viemGetBlockNumber,
  getTransaction as viemGetTransaction,
  getTransactionReceipt as viemGetTransactionReceipt,
} from 'viem/actions';
import { own } from '../arguments.js';
import { errorName } from '../safe-tracker.js';
import { sameHex, type ViemReceipt, type ViemReplacement } from './receipt.js';
import { within } from './timing.js';

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

/** How long telemetry waits for the transaction it reads after a send that passed no nonce. */
const SENT_TRANSACTION_TIMEOUT_MS = 10_000;

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
 * The sender and nonce of `hash`, sent through `client` by `from` (undefined for a raw send), read once with
 * `eth_getTransactionByHash` after a send that passed no nonce, off the caller's path; undefined when the node no longer
 * knows the transaction (a replacement took it out of the pool first), the request fails or takes longer than
 * `SENT_TRANSACTION_TIMEOUT_MS`, or the answer is not that transaction from that sender. Never rejects.
 */
export function readSentTransaction(
  client: unknown,
  hash: string,
  from: string | undefined,
): Promise<SentTransaction | undefined> {
  const read = viemGetTransaction(client as never, { hash: hash as `0x${string}` }).then(
    (transaction: unknown) => {
      if (!sameHex(own(transaction, 'hash'), hash)) return undefined;
      const sender = own(transaction, 'from');
      if (from !== undefined && !sameHex(sender, from)) return undefined;
      return sentTransactionOf(sender, own(transaction, 'nonce'), own(transaction, 'to'));
    },
    (error: unknown) => {
      diag.debug(`hashspan: could not read the sent transaction (${errorName(error)})`);
      return undefined;
    },
  );
  return within(read, SENT_TRANSACTION_TIMEOUT_MS, 'read the sent transaction');
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
 * fails, other than the first and the nonce before the window.
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
  // Requested directly: viem before 2.29.1 sends block 0 as `latest` (wevm/viem#3629), and on a chain younger than the
  // window the search reads block 0.
  const nonceAt = async (blockNumber: bigint): Promise<number> =>
    hexToNumber(
      await (viemClient as { request: (args: unknown) => Promise<`0x${string}`> }).request({
        method: 'eth_getTransactionCount',
        params: [address, numberToHex(blockNumber)],
      }),
    );
  // The nonce after a block is the count of transactions the sender had mined by then.
  if ((await nonceAt(latest)) <= sent.nonce) return undefined;
  // Block -1 stands for the state before the first block, where no nonce is taken.
  let low = latest - BigInt(MAX_REPLACEMENT_BLOCKS);
  if (low < 0n) low = -1n;
  else {
    // Taken before the window: not searched. A node without that block's state fails this request; the search then
    // goes on, and a nonce taken earlier still finds no match in the block it ends at.
    const before = await nonceAt(low).catch(() => undefined);
    if (before !== undefined && before > sent.nonce) return undefined;
  }
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
