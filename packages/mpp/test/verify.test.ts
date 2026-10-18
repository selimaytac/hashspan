// `blockchain.payment.verified` (ADR 0029), offline: the settlement's receipt, as a reader returns it, checked against
// the challenge the payer signed for and the payer's own credential. Receipts are written here, with the attribution
// memo mppx itself encodes (`Attribution.encode` from mppx/tempo).
import { diag } from '@opentelemetry/api';
import { Attribution } from 'mppx/tempo';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
  parseAbi,
} from 'viem';
import { tempo as tempoChain } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  CHAIN_ID,
  CONFIRM_SPAN,
  CURRENCY,
  decodeCredential,
  hashOf,
  minedTransactionOf,
  offlineRpc,
  PAYER,
  PAYMENT_SPAN,
  paidApi,
  paidServer,
  REALM,
  RECIPIENT,
  receiptHeader,
  rpcReceipt,
  SPLIT_RECIPIENT,
  testClient,
  URL_PAID,
} from './fake-mppx.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const TIP20 = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
]);
const OTHER = '0x4444444444444444444444444444444444444444';

interface Transfer {
  from?: string;
  to: string;
  amount: bigint;
  memo?: Hex | undefined;
  token?: string;
}

/** The logs a TIP-20 transfer emits: `Transfer`, and `TransferWithMemo` beside it for a memo. */
function logsOf(transfers: readonly Transfer[]) {
  let logIndex = 0;
  const log = (token: string, topics: Hex[], amount: bigint) => ({
    address: token,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    blockNumber: '0x11',
    blockHash: `0x${'22'.repeat(32)}`,
    transactionHash: `0x${'00'.repeat(32)}`,
    transactionIndex: '0x0',
    logIndex: `0x${(logIndex++).toString(16)}`,
    removed: false,
  });
  return transfers.flatMap(({ from = PAYER.address, to, amount, memo, token = CURRENCY }) => {
    const args = { from: from as Hex, to: to as Hex };
    const transfer = log(
      token,
      encodeEventTopics({ abi: TIP20, eventName: 'Transfer', args }) as Hex[],
      amount,
    );
    if (!memo) return [transfer];
    return [
      transfer,
      log(
        token,
        encodeEventTopics({
          abi: TIP20,
          eventName: 'TransferWithMemo',
          args: { ...args, memo },
        }) as Hex[],
        amount,
      ),
    ];
  });
}

/** The memo mppx writes for a challenge of this realm. */
const memoFor = (challengeId: string, serverId = REALM) =>
  Attribution.encode({ challengeId, serverId }) as Hex;

interface Run {
  /** The transfers the settlement's receipt carries, given the paid challenge's id. */
  transfers?: (challengeId: string) => Transfer[];
  receipt?: Record<string, unknown>;
  /** What the server reports as `reference`; default: the payer's own hash. */
  reference?: string;
  receiptExtra?: Record<string, unknown>;
  /** Changes the logs written from `transfers`. */
  logs?: (logs: ReturnType<typeof logsOf>) => unknown[];
  server?: ReturnType<typeof paidServer>;
  reader?: 'none' | 'other-chain';
  /** What the reader returns for the reported transaction; default: one made from its receipt. */
  transaction?: ((credential: string, reference: string) => unknown) | undefined;
}

/** Pays once in pull mode, with the reader on the offline chain, and returns the payment span's verdict. */
async function verdict(run: Run = {}) {
  const rpc = offlineRpc();
  const api = paidApi((credential) => {
    const id = (decodeCredential(credential).challenge as { id: string }).id;
    const own = hashOf(credential) as Hex;
    const reference = (run.reference ?? own) as Hex;
    rpc.mined.set(
      reference,
      rpcReceipt(reference, {
        logs: (run.logs ?? ((logs) => logs))(run.transfers ? logsOf(run.transfers(id)) : []),
        ...run.receipt,
      }),
    );
    if (run.transaction) rpc.transactions.set(reference, run.transaction(credential, reference));
    return new Response('{}', {
      headers: { 'payment-receipt': receiptHeader(reference, run.receiptExtra) },
    });
  }, run.server);
  const client = testClient(api.fetch, { mode: 'pull' });
  const reader =
    run.reader === 'none'
      ? undefined
      : createPublicClient({
          chain: run.reader === 'other-chain' ? { ...tempoChain, id: CHAIN_ID + 1 } : tempoChain,
          transport: rpc.transport,
        });
  const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 500 });
  await client.fetch(URL_PAID);
  expect(await hashspan.flush()).toBe(true);
  return tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.verified'];
}

const primary = (id: string, amount = 10_000n): Transfer => ({
  to: RECIPIENT,
  amount,
  memo: memoFor(id),
});

describe('a verified payment', () => {
  it('is true when the receipt carries the transfer with the memo of this challenge', async () => {
    expect(await verdict({ transfers: (id) => [primary(id)] })).toBe(true);
  });

  it('pairs the Transfer and TransferWithMemo of one transfer in either order, and skips logs that do not decode', async () => {
    const undecodable = {
      address: CURRENCY,
      topics: [`0x${'99'.repeat(32)}`],
      data: '0x',
      blockNumber: '0x11',
      blockHash: `0x${'22'.repeat(32)}`,
      transactionHash: `0x${'00'.repeat(32)}`,
      transactionIndex: '0x0',
      logIndex: '0x9',
      removed: false,
    };
    expect(
      await verdict({
        transfers: (id) => [primary(id)],
        logs: (logs) => [
          undecodable,
          ...[...logs]
            .reverse()
            .map((log, index) => ({ ...log, logIndex: `0x${index.toString(16)}` })),
        ],
      }),
    ).toBe(true);
  });

  it('is true for a charge with splits, each a transfer from the payer, the primary of the amount less the splits', async () => {
    const server = paidServer({
      amount: '0.03',
      splits: [
        { amount: '0.01', recipient: SPLIT_RECIPIENT },
        { amount: '0.005', recipient: OTHER },
      ],
    });
    expect(
      await verdict({
        server,
        transfers: (id) => [
          primary(id, 15_000n),
          { to: SPLIT_RECIPIENT, amount: 10_000n },
          { to: OTHER, amount: 5_000n },
        ],
      }),
    ).toBe(true);
  });

  it('is false when a split is missing, even if the primary transfer could stand in for it', async () => {
    // The split goes to the primary recipient, of the primary amount: only the primary transfer's two logs are there.
    const server = paidServer({
      amount: '0.02',
      splits: [{ amount: '0.01', recipient: RECIPIENT }],
    });
    expect(await verdict({ server, transfers: (id) => [primary(id, 10_000n)] })).toBe(false);
  });

  it.each([
    [
      'the memo of another challenge (an earlier payment of the same payer, recipient and amount)',
      (id: string) => [{ ...primary(id), memo: memoFor(`${id}-earlier`) }],
    ],
    [
      'the memo of another realm',
      (id: string) => [{ ...primary(id), memo: memoFor(id, 'other.example.com') }],
    ],
    ['no memo', (id: string) => [{ ...primary(id), memo: undefined }]],
    [
      'a memo without the MPP tag',
      (id: string) => [{ ...primary(id), memo: `0x${'00'.repeat(32)}` as Hex }],
    ],
    ['another amount', (id: string) => [primary(id, 9_999n)]],
    ['another recipient', (id: string) => [{ ...primary(id), to: OTHER }]],
    ['another sender', (id: string) => [{ ...primary(id), from: OTHER }]],
    ['another token', (id: string) => [{ ...primary(id), token: OTHER }]],
    ['no transfer', () => []],
  ])('is false for a receipt with %s', async (_name, transfers) => {
    expect(await verdict({ transfers })).toBe(false);
  });

  it("is false when the server reports a hash other than the payer's own, whatever that receipt carries", async () => {
    expect(
      await verdict({ reference: `0x${'77'.repeat(32)}`, transfers: (id) => [primary(id)] }),
    ).toBe(false);
  });

  it("is true for a sponsored pull whose mined transaction is the payer's signed one, carrying the memo", async () => {
    const server = paidServer({ feePayer: true });
    const reference = `0x${'5a'.repeat(32)}`;
    expect(
      await verdict({
        server,
        reference,
        transfers: (id) => [primary(id)],
        transaction: minedTransactionOf,
      }),
    ).toBe(true);
  });

  it('is false for a sponsored pull whose receipt does not carry the charge', async () => {
    const server = paidServer({ feePayer: true });
    const reference = `0x${'5a'.repeat(32)}`;
    expect(
      await verdict({
        server,
        reference,
        transfers: (id) => [primary(id, 9_999n)],
        transaction: minedTransactionOf,
      }),
    ).toBe(false);
  });
});

describe('a sponsored pull, whose hash only the server reports', () => {
  const server = () => paidServer({ feePayer: true });
  const reference = `0x${'5a'.repeat(32)}` as Hex;
  type Mined = (credential: string, hash: string) => unknown;
  /** The payer's mined transaction with `field` changed by `change`, or removed. */
  const withField =
    (field: string, change?: (value: bigint) => unknown): Mined =>
    (credential, hash) => {
      const { [field]: value, ...mined } = minedTransactionOf(credential, hash);
      return change ? { ...mined, [field]: change(BigInt(value as string)) } : mined;
    };
  const NONCE_FIELDS = ['nonceKey', 'nonce', 'validBefore', 'validAfter'] as const;

  it.each<[string, Mined | undefined]>([
    ['a transaction without the Tempo nonce fields', undefined],
    ['no transaction (null)', () => null],
    [
      'a transaction from another sender',
      (credential, hash) => minedTransactionOf(credential, hash, { from: OTHER }),
    ],
    ...NONCE_FIELDS.map((field): [string, Mined] => [
      `a transaction with another ${field}`,
      withField(field, (value) => `0x${(value + 1n).toString(16)}`),
    ]),
    ...['from', ...NONCE_FIELDS].map((field): [string, Mined] => [
      `a transaction without ${field}`,
      withField(field),
    ]),
    ...NONCE_FIELDS.map((field): [string, Mined] => [
      `a transaction whose ${field} is a number`,
      withField(field, (value) => Number(value)),
    ]),
    ...NONCE_FIELDS.map((field): [string, Mined] => [
      `a transaction whose ${field} is longer than a quantity`,
      withField(field, () => `0x1${'0'.repeat(64)}`),
    ]),
    ['a transaction that is not an object', () => '0x76'],
  ])(
    'has no verdict for %s, although the receipt carries the charge',
    async (_name, transaction) => {
      expect(
        await verdict({
          server: server(),
          reference,
          transfers: (id) => [primary(id)],
          transaction,
        }),
      ).toBeUndefined();
    },
  );

  it('has no verdict when the server repeats a challenge and reports the settlement of the earlier payment', async () => {
    const rpc = offlineRpc();
    // The same challenge, id included, for both paid requests.
    const challenges = server();
    let challenge: Response | undefined;
    const repeated = async (request: Request) => {
      challenge ??= await challenges(request);
      return challenge.clone();
    };
    let settledOnce = false;
    const api = paidApi((credential) => {
      const id = (decodeCredential(credential).challenge as { id: string }).id;
      if (!settledOnce) {
        // The first payment settles in its own transaction, which the reader returns.
        settledOnce = true;
        rpc.mined.set(reference, rpcReceipt(reference, { logs: logsOf([primary(id)]) }));
        rpc.transactions.set(reference, minedTransactionOf(credential, reference));
      }
      // Both answers name the first payment's transaction.
      return new Response('{}', { headers: { 'payment-receipt': receiptHeader(reference) } });
    }, repeated);
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({ chain: tempoChain, transport: rpc.transport });
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 500 });
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    const payments = tracing.spans().filter(({ name }) => name === PAYMENT_SPAN);
    expect(payments).toHaveLength(2);
    expect(payments[1]?.attributes['mpp.challenge.id']).toBe(
      payments[0]?.attributes['mpp.challenge.id'],
    );
    expect(payments[0]?.attributes['blockchain.payment.verified']).toBe(true);
    expect(payments[1]?.attributes['blockchain.tx.hash']).toBe(reference);
    expect(payments[1]?.attributes['blockchain.payment.status']).toBe('settled');
    expect(payments[1]?.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it('reads the transaction once, through the reader, by the hash of the receipt', async () => {
    const rpc = offlineRpc();
    const api = paidApi((credential) => {
      const id = (decodeCredential(credential).challenge as { id: string }).id;
      rpc.mined.set(reference, rpcReceipt(reference, { logs: logsOf([primary(id)]) }));
      rpc.transactions.set(reference, minedTransactionOf(credential, reference));
      return new Response('{}', { headers: { 'payment-receipt': receiptHeader(reference) } });
    }, server());
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({ chain: tempoChain, transport: rpc.transport });
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 500 });
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    const reads = rpc.requests.filter(({ method }) => method === 'eth_getTransactionByHash');
    expect(reads).toEqual([{ method: 'eth_getTransactionByHash', params: [reference] }]);
    expect(tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.verified']).toBe(true);
  });

  it.each([
    ['fails', () => Promise.reject(new Error('unavailable'))],
    [
      'throws',
      () => {
        throw new Error('unavailable');
      },
    ],
  ])('has no verdict when the read of the transaction %s', async (_name, transaction) => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const rpc = offlineRpc();
    const api = paidApi((credential) => {
      const id = (decodeCredential(credential).challenge as { id: string }).id;
      rpc.mined.set(reference, rpcReceipt(reference, { logs: logsOf([primary(id)]) }));
      return new Response('{}', { headers: { 'payment-receipt': receiptHeader(reference) } });
    }, server());
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({ chain: tempoChain, transport: rpc.transport });
    const request = reader.request.bind(reader);
    // Only the adapter's own read of the transaction fails; viem's receipt wait reads the receipt first.
    reader.request = ((args: { method: string }) =>
      args.method === 'eth_getTransactionByHash' ? transaction() : request(args as never)) as never;
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 500 });
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it('ends without a verdict, off the caller, when the read of the transaction never answers', async () => {
    const rpc = offlineRpc();
    const api = paidApi((credential) => {
      const id = (decodeCredential(credential).challenge as { id: string }).id;
      rpc.mined.set(reference, rpcReceipt(reference, { logs: logsOf([primary(id)]) }));
      rpc.transactions.set(reference, new Promise(() => {}));
      return new Response('{}', { headers: { 'payment-receipt': receiptHeader(reference) } });
    }, server());
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({
      chain: tempoChain,
      transport: rpc.transport,
      pollingInterval: 20,
    });
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 500 });
    const response = await client.fetch(URL_PAID);
    expect(response.status).toBe(200);
    expect(await hashspan.flush({ timeoutMs: 300 })).toBe(false);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
  });

  it('gives up the read of the transaction after 10 seconds, and ends without a verdict', async () => {
    const rpc = offlineRpc();
    const api = paidApi((credential) => {
      const id = (decodeCredential(credential).challenge as { id: string }).id;
      rpc.mined.set(reference, rpcReceipt(reference, { logs: logsOf([primary(id)]) }));
      rpc.transactions.set(reference, new Promise(() => {}));
      return new Response('{}', { headers: { 'payment-receipt': receiptHeader(reference) } });
    }, server());
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({
      chain: tempoChain,
      transport: rpc.transport,
      pollingInterval: 20,
    });
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 500 });
    await client.fetch(URL_PAID);
    // The receipt is read; then the transaction read hangs until the adapter's own bound ends it.
    await vi.waitFor(() =>
      expect(rpc.requests.map(({ method }) => method)).toContain('eth_getTransactionByHash'),
    );
    expect(tracing.spans().filter(({ name }) => name === PAYMENT_SPAN)).toEqual([]);
    expect(await hashspan.flush({ timeoutMs: 11_000 })).toBe(true);
    expect(
      tracing.spanNamed(PAYMENT_SPAN).attributes['blockchain.payment.verified'],
    ).toBeUndefined();
  }, 15_000);
});

describe('a payment without a verdict', () => {
  it.each([
    ['without a reader', { reader: 'none' as const }],
    ['with a reader on another chain', { reader: 'other-chain' as const }],
    ['for a reverted receipt', { receipt: { status: '0x0' } }],
    [
      'for a receipt funded in another currency (an auto-swap route)',
      { receiptExtra: { fundingCurrency: OTHER } },
    ],
  ])('has none %s', async (_name, run) => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    expect(await verdict({ transfers: (id) => [primary(id)], ...run })).toBeUndefined();
  });

  it('has none when no receipt came before the confirmation timed out, and still ends settled', async () => {
    const rpc = offlineRpc();
    const api = paidApi(
      (credential) =>
        new Response('{}', { headers: { 'payment-receipt': receiptHeader(hashOf(credential)) } }),
    );
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({
      chain: tempoChain,
      transport: rpc.transport,
      pollingInterval: 20,
    });
    const hashspan = withHashspan(client, { reader, confirmTimeoutMs: 100 });
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.status']).toBe('settled');
    expect(span.attributes['blockchain.payment.verified']).toBeUndefined();
    expect(tracing.spanNamed(CONFIRM_SPAN).attributes['error.type']).toBe('timeout');
  });

  it('keeps the end time of the response when it ends after the check', async () => {
    const rpc = offlineRpc();
    let answeredAt = 0;
    const api = paidApi((credential) => {
      const id = (decodeCredential(credential).challenge as { id: string }).id;
      const hash = keccak256(
        (decodeCredential(credential).payload as { signature: Hex }).signature,
      );
      // The receipt shows up later than the response.
      setTimeout(() => rpc.mined.set(hash, rpcReceipt(hash, { logs: logsOf([primary(id)]) })), 150);
      answeredAt = Date.now();
      return new Response('{}', { headers: { 'payment-receipt': receiptHeader(hash) } });
    });
    const client = testClient(api.fetch, { mode: 'pull' });
    const reader = createPublicClient({
      chain: tempoChain,
      transport: rpc.transport,
      pollingInterval: 20,
    });
    const hashspan = withHashspan(client, { reader });
    await client.fetch(URL_PAID);
    expect(await hashspan.flush()).toBe(true);
    const span = tracing.spanNamed(PAYMENT_SPAN);
    expect(span.attributes['blockchain.payment.verified']).toBe(true);
    const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
    expect(endMs).toBeGreaterThanOrEqual(answeredAt);
    expect(endMs).toBeLessThan(answeredAt + 100);
    // The confirm span links to the payment span.
    expect(tracing.spanNamed(CONFIRM_SPAN).links.map((l) => l.context.spanId)).toEqual([
      span.spanContext().spanId,
    ]);
  });
});
