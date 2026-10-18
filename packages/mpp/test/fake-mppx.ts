// A real mppx client and a real mppx server's challenges, offline: the payer's viem client talks to a JSON-RPC stand-in
// that signs nothing and answers what mppx asks for a Tempo charge, and the paid API answers the paid request as the
// test says. The adapter sees the client's real events, from mppx's own Fetch.js, with real push and pull credentials.
import { Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { Mppx as ServerMppx, tempo as serverTempo } from 'mppx/server';
import { createClient, custom, fromRlp, type Hex, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoChain } from 'viem/chains';

/** Tempo mainnet's chain id, which viem's `tempo` chain and mppx's defaults use. */
export const CHAIN_ID = 4217;
/** Anvil's second test account: the payer. */
export const PAYER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
/** Anvil's third test account: the server, also the fee payer of sponsored charges. */
export const SERVER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);
export const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
export const SPLIT_RECIPIENT = '0x00000000000000000000000000000000000000dd' as const;
/** pathUSD, which Anvil in Tempo mode funds every test account with. */
export const CURRENCY = '0x20c0000000000000000000000000000000000001' as const;
export const REALM = 'api.example.com';
export const URL_PAID = 'https://api.example.com/weather';
export const PAYMENT_SPAN = `payment ${CHAIN_ID}`;
export const CONFIRM_SPAN = `confirm ${CHAIN_ID}`;
/** The server's HMAC key for challenge ids: mppx asks for 32 bytes; a test needs no secret. */
const HMAC_KEY = 'x'.repeat(32);

/** A receipt as Tempo returns it, for the transaction `hash`. */
export function rpcReceipt(
  hash: Hex,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    transactionHash: hash,
    status: '0x1',
    blockNumber: '0x11',
    blockHash: `0x${'22'.repeat(32)}`,
    transactionIndex: '0x0',
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    gasUsed: '0x5208',
    effectiveGasPrice: '0x4a817c800',
    cumulativeGasUsed: '0x5208',
    type: '0x76',
    from: PAYER.address.toLowerCase(),
    to: CURRENCY,
    contractAddress: null,
    feeToken: CURRENCY,
    feePayer: PAYER.address.toLowerCase(),
    ...extra,
  };
}

/**
 * The JSON-RPC stand-in of the payer's (and reader's) chain: what mppx's Tempo charge asks while it prepares, signs and,
 * for push, sends a transaction. `eth_sendRawTransactionSync` answers with a receipt of the raw transaction's hash,
 * `eth_getTransactionReceipt` with the receipts `mined` holds, and `eth_getTransactionByHash` with what
 * `transactions` holds for the hash, else a transaction made from the receipt.
 */
export function offlineRpc(options: { failSend?: boolean } = {}) {
  const requests: { method: string; params: unknown[] }[] = [];
  const mined = new Map<string, Record<string, unknown>>();
  const transactions = new Map<string, unknown>();
  // A new block on every poll, so viem's receipt wait looks again.
  let block = 0x11;
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown[] }) {
      requests.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return `0x${CHAIN_ID.toString(16)}`;
        case 'eth_getTransactionCount':
          return '0x0';
        case 'eth_estimateGas':
          return '0x30000';
        case 'eth_maxPriorityFeePerGas':
          return '0x0';
        case 'eth_gasPrice':
          return '0x4a817c800';
        case 'eth_blockNumber':
          return `0x${(block++).toString(16)}`;
        case 'eth_getBlockByNumber':
          return {
            baseFeePerGas: '0x4a817c800',
            number: '0x11',
            timestamp: '0x1',
            hash: `0x${'11'.repeat(32)}`,
            transactions: [],
          };
        case 'eth_sendRawTransactionSync': {
          if (options.failSend) throw new Error('nonce too low');
          const hash = keccak256((params as [Hex])[0]);
          const receipt = rpcReceipt(hash);
          mined.set(hash, receipt);
          return receipt;
        }
        case 'eth_getTransactionReceipt':
          return mined.get((params as [string])[0]) ?? null;
        case 'eth_getTransactionByHash': {
          const [hash] = params as [string];
          if (transactions.has(hash)) return transactions.get(hash);
          // viem's receipt wait looks for the transaction before it looks for its receipt again.
          const receipt = mined.get(hash);
          return receipt
            ? {
                hash: receipt.transactionHash,
                from: receipt.from,
                to: receipt.to,
                nonce: '0x0',
                input: '0x',
                value: '0x0',
                gas: '0x30000',
                maxFeePerGas: '0x4a817c800',
                maxPriorityFeePerGas: '0x0',
                blockHash: receipt.blockHash,
                blockNumber: receipt.blockNumber,
                transactionIndex: '0x0',
                type: '0x2',
                chainId: `0x${CHAIN_ID.toString(16)}`,
                accessList: [],
                v: '0x0',
                r: `0x${'01'.repeat(32)}`,
                s: `0x${'01'.repeat(32)}`,
                yParity: '0x0',
              }
            : null;
        }
        default:
          // viem asks a node to fill a Tempo transaction first and falls back to filling it itself.
          throw new Error(`the offline chain does not answer ${method}`);
      }
    },
  });
  return { transport, requests, mined, transactions };
}

/**
 * The mined transaction of a pull credential, as a Tempo node returns it for `eth_getTransactionByHash`: the sender
 * and the nonce and validity fields the payer signed, decoded from the credential's 0x76 or 0x78 envelope, with
 * `extra` over them.
 */
export function minedTransactionOf(
  credential: string,
  hash: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const signed = (decodeCredential(credential).payload as { signature: Hex }).signature;
  const fields = fromRlp(`0x${signed.slice(4)}`, 'hex') as Hex[];
  const quantity = (value: Hex | undefined) =>
    `0x${BigInt(value === '0x' ? 0 : (value as Hex)).toString(16)}`;
  return {
    hash,
    type: '0x76',
    chainId: `0x${CHAIN_ID.toString(16)}`,
    from: PAYER.address.toLowerCase(),
    nonceKey: quantity(fields[6]),
    nonce: quantity(fields[7]),
    validBefore: quantity(fields[8]),
    validAfter: quantity(fields[9]),
    blockHash: `0x${'22'.repeat(32)}`,
    blockNumber: '0x11',
    transactionIndex: '0x0',
    ...extra,
  };
}

/** A viem client of the payer on the offline chain, as mppx's `getClient` returns it. */
export function payerClient(rpc = offlineRpc()) {
  return createClient({ account: PAYER, chain: tempoChain, transport: rpc.transport });
}

export interface ChargeOptions {
  /** Amount in the currency's units, with its 6 decimals. Default: `0.01`. */
  amount?: string;
  splits?: { amount: string; recipient: string }[];
  /** Whether the server sponsors the transaction's fee (a pull credential then awaits its signature). */
  feePayer?: boolean;
  supportedModes?: ('push' | 'pull')[];
  expires?: string;
}

/** A real mppx server's charge, whose 402 challenges the paid API answers with. */
export function paidServer(options: ChargeOptions = {}) {
  const server = ServerMppx.create({
    methods: [
      serverTempo({
        recipient: RECIPIENT,
        currency: CURRENCY,
        chainId: CHAIN_ID,
        account: SERVER,
        ...(options.feePayer ? { feePayer: true } : {}),
        getClient: () => payerClient() as never,
      }),
    ],
    secretKey: HMAC_KEY,
    realm: REALM,
  });
  return async (request: Request): Promise<Response> => {
    const result = await server.charge({
      amount: options.amount ?? '0.01',
      ...(options.splits ? { splits: options.splits } : {}),
      ...(options.supportedModes ? { supportedModes: options.supportedModes } : {}),
      ...(options.expires ? { expires: options.expires } : {}),
    } as never)(request);
    if (result.status !== 402)
      throw new Error('the test server expects to answer with a challenge');
    return result.challenge as Response;
  };
}

/** A `Payment-Receipt` header value for `reference`, as an mppx server writes it. */
export function receiptHeader(reference: string, extra: Record<string, unknown> = {}): string {
  return Receipt.serialize({
    method: 'tempo',
    reference,
    status: 'success',
    timestamp: new Date().toISOString(),
    ...extra,
  } as never);
}

/** How the paid API answers a paid request; it gets the credential the request carries. */
export type PaidAnswer = (credential: string, request: Request) => Response | Promise<Response>;

/** Answers a settled payment with `reference` (default: the hash the credential determines). */
export const settled =
  (reference?: (credential: string) => string): PaidAnswer =>
  (credential) =>
    new Response('{"temperature":21}', {
      headers: {
        'content-type': 'application/json',
        'payment-receipt': receiptHeader(reference?.(credential) ?? hashOf(credential)),
      },
    });

/** The hash a push or unsponsored pull credential determines, as the server would report it. */
export function hashOf(credential: string): string {
  const payload = decodeCredential(credential).payload as {
    type: string;
    hash?: Hex;
    signature?: Hex;
  };
  if (payload.type === 'hash' && payload.hash) return payload.hash;
  if (payload.type === 'transaction' && payload.signature) return keccak256(payload.signature);
  return `0x${'ee'.repeat(32)}`;
}

/** A credential's JSON, decoded as the adapter must decode it. */
export function decodeCredential(credential: string): {
  challenge: Record<string, unknown>;
  payload: Record<string, unknown>;
  source?: string;
} {
  const encoded = credential.replace(/^Payment\s+/i, '');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

/** A credential with its JSON changed by `change`, encoded as mppx encodes one. */
export function recodeCredential(
  credential: string,
  change: (json: Record<string, unknown>) => void,
): string {
  const json = decodeCredential(credential) as unknown as Record<string, unknown>;
  change(json);
  return `Payment ${Buffer.from(JSON.stringify(json)).toString('base64url')}`;
}

/** The paid API: challenges from `server` for a request without a credential, `answer` for one with it. */
export function paidApi(answer: PaidAnswer, server = paidServer()) {
  const paidRequests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const credential = request.headers.get('authorization');
    if (!credential) return server(request);
    paidRequests.push(request);
    return answer(credential, request);
  };
  return { fetch, paidRequests };
}

export interface ClientOptions {
  mode?: 'push' | 'pull';
  rpc?: ReturnType<typeof offlineRpc>;
  maxPaymentRetries?: number;
}

/** A real mppx client paying through `fetch` with a Tempo charge of {@link PAYER}, without polyfilling `fetch`. */
export function testClient(
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  options: ClientOptions = {},
) {
  const client = payerClient(options.rpc);
  return Mppx.create({
    methods: [
      tempo({
        account: PAYER,
        ...(options.mode ? { mode: options.mode } : {}),
        getClient: () => client as never,
      }),
    ],
    fetch: fetch as never,
    polyfill: false,
    ...(options.maxPaymentRetries !== undefined
      ? { maxPaymentRetries: options.maxPaymentRetries }
      : {}),
  });
}

/** A challenge as the client's events carry it: a plain object, as mppx's `structuredClone` makes it. */
export function challengeOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qB3wVm6v2Jt4Xk9rLp0sZ_aQ-1yHc8NdEfGhIjKlMnO',
    realm: REALM,
    method: 'tempo',
    intent: 'charge',
    request: {
      amount: '10000',
      currency: CURRENCY,
      recipient: RECIPIENT,
      methodDetails: { chainId: CHAIN_ID },
    },
    ...overrides,
  };
}

/** A credential string as mppx serializes one, for `challenge` with `payload` from `source`. */
export function credentialFor(
  challenge: Record<string, unknown>,
  payload: Record<string, unknown> = { type: 'hash', hash: `0x${'9f'.repeat(32)}` },
  source: string | null = `did:pkh:eip155:${CHAIN_ID}:${PAYER.address}`,
): string {
  const json = { challenge, payload, ...(source !== null ? { source } : {}) };
  return `Payment ${Buffer.from(JSON.stringify(json)).toString('base64url')}`;
}

type Handler = (payload: unknown) => unknown;

/**
 * A stand-in for an mppx client with `on()` only, whose events a test emits itself: for payloads mppx would not send,
 * and for rows a real client cannot reach offline.
 */
export function fakeClient() {
  const handlers = new Map<string, Handler[]>();
  return {
    client: {
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return () => {};
      },
    },
    handlers,
    /** Runs the handlers of `name` with `payload`, as mppx does (awaited in turn), and returns what they returned. */
    async emit(name: string, payload: unknown): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(payload));
      return results;
    },
  };
}
