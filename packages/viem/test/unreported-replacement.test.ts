// A replacement viem did not report, because the replacing transaction took the original out of the node's pool before
// viem's wait read it: hashspan looks for it after the wait timed out (ADR 0008 amendment).
import { SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, custom, RpcRequestError } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REPLACEMENT_BLOCKS } from '../src/confirm/replacement.js';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const MINED = `0x${'cd'.repeat(32)}` as const;
const NONCE = 7;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

interface ChainOptions {
  /** The chain's latest block. */
  latest?: number;
  /** The block whose transaction from FROM took NONCE; null while it is not taken. */
  takenAt?: number | null;
  /** The hash of the transaction that took NONCE. */
  takenBy?: string;
  /** Methods that fail, or never answer. */
  failOn?: string[];
  /** A block whose `eth_getTransactionCount` fails, as on a node without its state. */
  failNonceAt?: number;
  /** How many `eth_getTransactionByHash` requests still find HASH pending before the node drops it. */
  knownFor?: number;
  /** How many `eth_getTransactionByHash` requests fail first. */
  failedReads?: number;
  hangOn?: string[];
}

/**
 * A chain on which FROM's transaction HASH, with NONCE, was taken out of the pool: `eth_getTransactionByHash` knows it
 * no more, and the transaction `takenBy` took its nonce in block `takenAt`.
 */
function chain({
  latest = 1_000,
  takenAt = 990,
  takenBy = MINED,
  failOn = [],
  hangOn = [],
  failNonceAt,
  knownFor = 0,
  failedReads = 0,
}: ChainOptions = {}) {
  let failures = 0;
  let reads = 0;
  const requests: { method: string; params: unknown[] }[] = [];
  const minedTransaction = {
    hash: takenBy,
    from: FROM,
    to: FROM,
    input: '0x',
    value: '0x0',
    gas: '0x5208',
    nonce: hex(NONCE),
    blockHash: `0x${'ee'.repeat(32)}`,
    blockNumber: hex(takenAt ?? 0),
    transactionIndex: '0x0',
    type: '0x2',
    chainId: '0x2105',
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x1',
    accessList: [],
    v: '0x0',
    r: `0x${'11'.repeat(32)}`,
    s: `0x${'22'.repeat(32)}`,
    yParity: '0x0',
  };
  const transport = custom({
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      requests.push({ method, params });
      if (hangOn.includes(method)) return new Promise(() => {});
      if (failOn.includes(method)) {
        throw new RpcRequestError({
          body: {},
          error: { code: -32602, message: `mock: ${method} failed` },
          url: 'mock',
        });
      }
      switch (method) {
        case 'eth_chainId':
          return '0x2105';
        case 'eth_sendTransaction':
        case 'eth_sendRawTransaction':
          return HASH;
        case 'eth_blockNumber':
          return hex(latest);
        case 'eth_getTransactionByHash':
          if (failures++ < failedReads) {
            throw new RpcRequestError({
              body: {},
              error: { code: -32602, message: 'mock: read failed' },
              url: 'mock',
            });
          }
          if (String(params[0]).toLowerCase() !== HASH || reads++ >= knownFor) return null;
          return {
            ...minedTransaction,
            hash: HASH,
            to: TO,
            value: '0x1',
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
          };
        case 'eth_getTransactionCount': {
          const tag = params[1];
          const at = tag === 'latest' || tag === 'pending' ? latest : Number(tag);
          if (at === failNonceAt) {
            throw new RpcRequestError({
              body: {},
              error: { code: -32000, message: 'missing trie node' },
              url: 'mock',
            });
          }
          return hex(takenAt !== null && at >= takenAt ? NONCE + 1 : NONCE);
        }
        case 'eth_getBlockByNumber': {
          const number = Number(params[0]);
          return {
            hash: `0x${'ee'.repeat(32)}`,
            parentHash: `0x${'00'.repeat(32)}`,
            number: hex(number),
            timestamp: '0x0',
            nonce: '0x0000000000000000',
            difficulty: '0x0',
            gasLimit: '0x1c9c380',
            gasUsed: '0x5208',
            miner: TO,
            extraData: '0x',
            baseFeePerGas: '0x1',
            logsBloom: `0x${'00'.repeat(256)}`,
            transactions: number === takenAt ? [minedTransaction] : [],
            uncles: [],
            size: '0x0',
            stateRoot: `0x${'00'.repeat(32)}`,
            receiptsRoot: `0x${'00'.repeat(32)}`,
            transactionsRoot: `0x${'00'.repeat(32)}`,
            sha3Uncles: `0x${'00'.repeat(32)}`,
            mixHash: `0x${'00'.repeat(32)}`,
          };
        }
        case 'eth_getTransactionReceipt': {
          if (String(params[0]).toLowerCase() !== takenBy.toLowerCase()) return null;
          return {
            transactionHash: takenBy,
            transactionIndex: '0x0',
            blockHash: `0x${'ee'.repeat(32)}`,
            blockNumber: hex(takenAt ?? 0),
            from: FROM,
            to: FROM,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x2',
            contractAddress: null,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x2',
          };
        }
        default:
          throw new Error(`mock chain: unexpected method ${method}`);
      }
    },
  });
  const reads_ = () => requests.filter((r) => r.method === 'eth_getTransactionByHash').length;
  const searched = () =>
    requests.filter(
      (r) => r.method === 'eth_getTransactionCount' || r.method === 'eth_getBlockByNumber',
    );
  return { transport, requests, searched, reads: reads_ };
}

function clients(transport: ReturnType<typeof chain>['transport'], hashspan = withHashspan()) {
  return {
    hashspan,
    wallet: createWalletClient({ account: FROM, chain: base, transport }).extend(hashspan),
    reader: createPublicClient({ chain: base, transport, pollingInterval: 10 }).extend(hashspan),
  };
}

const confirmOf = (hash: string) =>
  tracing
    .spans()
    .find((s) => s.name === 'confirm 8453' && s.attributes['blockchain.tx.hash'] === hash);

/** Sends HASH with `nonce`, waits for it until viem times out, and flushes. */
async function sendAndTimeOut(
  setup: ReturnType<typeof clients>,
  { nonce, wait = {} }: { nonce?: number | undefined; wait?: Record<string, unknown> } = {
    nonce: NONCE,
  },
) {
  const { wallet, reader, hashspan } = setup;
  const hash = await wallet.sendTransaction({ to: TO, value: 1n, nonce, gas: 21_000n });
  await expect(
    reader.waitForTransactionReceipt({ hash, timeout: 100, retryDelay: 1, ...wait }),
  ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
  return hashspan.flush({ timeoutMs: 5_000 });
}

describe('a replacement viem did not report', () => {
  it('ends the awaited transaction as replaced and records the mined one, without a reason', async () => {
    const mock = chain();
    expect(await sendAndTimeOut(clients(mock.transport))).toBe(true);

    expect(confirmOf(HASH)?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': MINED,
    });
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.reason']).toBeUndefined();
    expect(confirmOf(HASH)?.attributes['error.type']).toBeUndefined();
    expect(confirmOf(HASH)?.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(confirmOf(HASH)?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirmOf(MINED)?.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 990,
      'blockchain.tx.fee': '42000',
    });
    // Both spans end when the wait gave up, so their durations are the wait's.
    expect(confirmOf(MINED)?.endTime).toEqual(confirmOf(HASH)?.endTime);
    // A binary search over the window, then the block that took the nonce.
    expect(mock.searched().length).toBeLessThanOrEqual(Math.log2(MAX_REPLACEMENT_BLOCKS) + 3);
  });

  it('finds the block that took the nonce on a chain shorter than the window', async () => {
    const mock = chain({ latest: 5, takenAt: 0 });
    await sendAndTimeOut(clients(mock.transport));
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
    expect(confirmOf(MINED)?.attributes['blockchain.block.number']).toBe(0);
  });

  it('finds it in the newest block of the window', async () => {
    const mock = chain({ takenAt: 1_000 });
    await sendAndTimeOut(clients(mock.transport));
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
  });

  it('finds it in the oldest block of the window', async () => {
    const mock = chain({ takenAt: 1_000 - MAX_REPLACEMENT_BLOCKS + 1 });
    await sendAndTimeOut(clients(mock.transport));
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
  });

  it('is found when the node has no state for the block before the window', async () => {
    const mock = chain({ failNonceAt: 1_000 - MAX_REPLACEMENT_BLOCKS });
    await sendAndTimeOut(clients(mock.transport));
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
  });

  it('is looked for by watch() of a transaction sent through the same withHashspan()', async () => {
    const mock = chain();
    const { hashspan, wallet, reader } = clients(mock.transport);
    const hash = await wallet.sendTransaction({ to: TO, value: 1n, nonce: NONCE, gas: 21_000n });
    hashspan.watch(reader, { hash, timeoutMs: 100 });
    expect(await hashspan.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
  });

  it('is looked for by background confirmation too', async () => {
    const mock = chain();
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 100 } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mock.transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await wallet.sendTransaction({ to: TO, value: 1n, nonce: NONCE, gas: 21_000n });
    expect(await hashspan.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
    expect(confirmOf(MINED)?.attributes['blockchain.tx.status']).toBe('success');
  });
});

describe('the nonce of a send that passed none', () => {
  it('is read once after the send, and the replacement is found with it', async () => {
    const mock = chain({ knownFor: 1 });
    const { hashspan, wallet, reader } = clients(mock.transport);
    const hash = await wallet.sendTransaction({ to: TO, value: 1n, gas: 21_000n });
    expect(await hashspan.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(mock.reads()).toBe(1);

    await expect(
      reader.waitForTransactionReceipt({ hash, timeout: 100, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    expect(await hashspan.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(confirmOf(HASH)?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': MINED,
    });
  });

  it('is not read when the send passed one', async () => {
    const mock = chain({ knownFor: 1 });
    const { hashspan, wallet } = clients(mock.transport);
    await wallet.sendTransaction({ to: TO, value: 1n, nonce: NONCE, gas: 21_000n });
    await hashspan.flush({ timeoutMs: 5_000 });
    expect(mock.reads()).toBe(0);
  });

  it('is read for a raw send, which gives the sender too', async () => {
    const mock = chain({ knownFor: 1 });
    const setup = clients(mock.transport);
    const signer = mnemonicToAccount('test test test test test test test test test test test junk');
    const serializedTransaction = await signer.signTransaction({
      chainId: base.id,
      to: TO,
      value: 1n,
      nonce: NONCE,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    const hash = await setup.wallet.sendRawTransaction({ serializedTransaction });
    await expect(
      setup.reader.waitForTransactionReceipt({ hash, timeout: 100, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await setup.hashspan.flush({ timeoutMs: 5_000 });
    expect(confirmOf(HASH)?.attributes['blockchain.tx.replacement.hash']).toBe(MINED);
  });

  it('does not delay the send when the read never answers', async () => {
    const mock = chain({ hangOn: ['eth_getTransactionByHash'] });
    const { hashspan, wallet } = clients(mock.transport);
    await expect(wallet.sendTransaction({ to: TO, value: 1n, gas: 21_000n })).resolves.toBe(HASH);
    expect(await hashspan.flush({ timeoutMs: 100 })).toBe(false);
  });

  it('keeps the timeout when the read fails, and the send result unchanged', async () => {
    const mock = chain({ failedReads: 1 });
    const setup = clients(mock.transport);
    const hash = await setup.wallet.sendTransaction({ to: TO, value: 1n, gas: 21_000n });
    expect(hash).toBe(HASH);
    await expect(
      setup.reader.waitForTransactionReceipt({ hash, timeout: 100, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await setup.hashspan.flush({ timeoutMs: 5_000 });
    expect(confirmOf(HASH)?.attributes['error.type']).toBe('timeout');
    expect(mock.searched()).toHaveLength(0);
  });
});

describe('a timeout that stays a timeout', () => {
  const timedOut = () => {
    expect(confirmOf(HASH)?.attributes['error.type']).toBe('timeout');
    expect(confirmOf(HASH)?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirmOf(MINED)).toBeUndefined();
  };

  it('when the nonce is not taken yet, after one nonce request', async () => {
    const mock = chain({ takenAt: null });
    await sendAndTimeOut(clients(mock.transport));
    timedOut();
    expect(mock.searched()).toHaveLength(1);
  });

  it('when the nonce was taken before the window', async () => {
    const mock = chain({ takenAt: 1_000 - MAX_REPLACEMENT_BLOCKS });
    await sendAndTimeOut(clients(mock.transport));
    timedOut();
    expect(mock.searched()).toHaveLength(2);
  });

  it('when a request of the search fails', async () => {
    const mock = chain({ failOn: ['eth_getBlockByNumber'] });
    await sendAndTimeOut(clients(mock.transport));
    timedOut();
  });

  it('when the send passed no nonce and the node dropped it before hashspan read it', async () => {
    const mock = chain();
    await sendAndTimeOut(clients(mock.transport), { nonce: undefined });
    timedOut();
    expect(mock.searched()).toHaveLength(0);
  });

  it('when the transaction was not sent through this withHashspan()', async () => {
    const mock = chain();
    const reader = clients(mock.transport);
    await sendAndTimeOut({ ...reader, wallet: clients(mock.transport).wallet });
    timedOut();
    expect(mock.searched()).toHaveLength(0);
  });

  it('when the wait turned replacement detection off', async () => {
    const mock = chain();
    await sendAndTimeOut(clients(mock.transport), {
      nonce: NONCE,
      wait: { checkReplacement: false },
    });
    timedOut();
    expect(mock.searched()).toHaveLength(0);
  });

  it('when the chain turns replacement detection off', async () => {
    const mock = chain();
    const hashspan = withHashspan();
    const optedOut = { ...base, supportsTransactionReplacementDetection: false };
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mock.transport,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: optedOut,
      transport: mock.transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await sendAndTimeOut({ hashspan, wallet, reader } as never);
    timedOut();
    expect(mock.searched()).toHaveLength(0);
  });

  it('when the wait has checkReplacement behind an accessor', async () => {
    const mock = chain();
    const setup = clients(mock.transport);
    const hash = await setup.wallet.sendTransaction({
      to: TO,
      value: 1n,
      nonce: NONCE,
      gas: 21_000n,
    });
    const args = { hash, timeout: 100, retryDelay: 1 };
    Object.defineProperty(args, 'checkReplacement', { enumerable: true, get: () => true });
    await expect(setup.reader.waitForTransactionReceipt(args)).rejects.toThrow(
      expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }),
    );
    await setup.hashspan.flush({ timeoutMs: 5_000 });
    timedOut();
    expect(mock.searched()).toHaveLength(0);
  });

  it('when a raw send was dropped before hashspan read its sender', async () => {
    const mock = chain();
    const setup = clients(mock.transport);
    // Anvil's first account, from its public test mnemonic.
    const signer = mnemonicToAccount('test test test test test test test test test test test junk');
    const serializedTransaction = await signer.signTransaction({
      chainId: base.id,
      to: TO,
      value: 1n,
      nonce: NONCE,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    const hash = await setup.wallet.sendRawTransaction({ serializedTransaction });
    await expect(
      setup.reader.waitForTransactionReceipt({ hash, timeout: 100, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    await setup.hashspan.flush({ timeoutMs: 5_000 });
    timedOut();
    expect(mock.searched()).toHaveLength(0);
  });

  it('when a flush gives up during the search, at the time the wait gave up', async () => {
    const mock = chain({ hangOn: ['eth_getTransactionCount'] });
    const setup = clients(mock.transport);
    const hash = await setup.wallet.sendTransaction({
      to: TO,
      value: 1n,
      nonce: NONCE,
      gas: 21_000n,
    });
    await expect(
      setup.reader.waitForTransactionReceipt({ hash, timeout: 100, retryDelay: 1 }),
    ).rejects.toThrow(expect.objectContaining({ name: 'WaitForTransactionReceiptTimeoutError' }));
    const rejectedAt = Date.now();
    expect(await setup.hashspan.flush({ timeoutMs: 300 })).toBe(false);
    timedOut();
    const [seconds, nanos] = confirmOf(HASH)?.endTime ?? [0, 0];
    expect(seconds * 1_000 + nanos / 1e6).toBeLessThanOrEqual(rejectedAt + 1);
  });
});
