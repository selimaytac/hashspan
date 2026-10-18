// Real MPP charges on Anvil in Tempo mode, all in this process: an mppx server that verifies and settles on the local
// chain, and the accounts Anvil funds with pathUSD. Nothing leaves localhost: `guardEgress()` fails any other request.
import { Mppx as ServerMppx, tempo as serverTempo } from 'mppx/server';
import { type Chain, createClient, http, publicActions, type Transport, walletActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoChain } from 'viem/chains';
import { vi } from 'vitest';
import { type StartedAnvil, startAnvil } from '../../viem/test/start-anvil.js';

/** Tempo mainnet's chain id, as viem's `tempo` chain and mppx's defaults name it. */
export const CHAIN_ID = 4217;
/** Anvil's second test account: the payer. */
export const PAYER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
/** Anvil's third test account: the server, which broadcasts pull charges and sponsors fees. */
export const SERVER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);
/** Anvil's first test account, unlocked on the node: a JSON-RPC (wallet) account. */
export const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
export const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
export const SPLIT_RECIPIENT = '0x00000000000000000000000000000000000000dd' as const;
/** pathUSD, which Anvil in Tempo mode funds its test accounts with. */
export const CURRENCY = '0x20c0000000000000000000000000000000000001' as const;
export const REALM = 'api.example.com';
export const URL_PAID = 'https://api.example.com/weather';
export const PAYMENT_SPAN = `payment ${CHAIN_ID}`;
export const CONFIRM_SPAN = `confirm ${CHAIN_ID}`;
export const SEND_SPAN = `send ${CHAIN_ID}`;

/** Starts Anvil in Tempo mode and mines one block, so `latest` carries the current time (the `validAfter` check). */
export async function startTempoAnvil(): Promise<StartedAnvil & { chain: Chain }> {
  const anvil = await startAnvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    chainId: CHAIN_ID,
    network: 'tempo',
  });
  await fetch(anvil.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: ['0x1'] }),
  });
  return { ...anvil, chain: { ...tempoChain, rpcUrls: { default: { http: [anvil.rpcUrl] } } } };
}

/**
 * Lets `fetch` reach only 127.0.0.1 and the in-process paid API; any other request fails and is recorded, so a test
 * can assert that nothing left the machine (mppx's default RPC URL is a public Tempo endpoint).
 */
export function guardEgress(api?: (request: Request) => Promise<Response>): { blocked: string[] } {
  const blocked: string[] = [];
  const offline = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname === '127.0.0.1') return offline(input, init);
    if (api && hostname === 'api.example.com') return api(request);
    blocked.push(request.url);
    return Promise.reject(new TypeError('blocked by the test: no public network'));
  });
  return { blocked };
}

/** A viem client of `account` on the local chain, with public and wallet actions, as mppx's `getClient` returns. */
export function chainClient(
  chain: Chain,
  account: typeof PAYER | typeof WALLET,
  transport: Transport = http(chain.rpcUrls.default.http[0]),
) {
  return createClient({ account, chain, transport, pollingInterval: 50 })
    .extend(publicActions)
    .extend(walletActions);
}

export interface ServerOptions {
  /** The server sponsors the fee of pull charges as fee payer. */
  feePayer?: boolean;
  amount?: string;
  splits?: { amount: string; recipient: string }[];
  /** When the challenge expires, in milliseconds from when it is made. */
  expiresInMs?: number;
  /** How the server answers once the charge settled; default: 200 with the receipt. */
  after?: (settled: { withReceipt: (response: Response) => Response }) => Response;
  /** Answers the paid request without verifying it, with this response (a server that reports what it likes). */
  instead?: (request: Request) => Response | undefined;
}

/** A paid API: an mppx server charging for every request, on the local chain. */
export function paidApi(chain: Chain, options: ServerOptions = {}) {
  const serverClient = chainClient(chain, SERVER);
  const server = ServerMppx.create({
    methods: [
      serverTempo({
        recipient: RECIPIENT,
        currency: CURRENCY,
        chainId: CHAIN_ID,
        account: SERVER,
        ...(options.feePayer ? { feePayer: true } : {}),
        getClient: () => serverClient as never,
      }),
    ],
    // mppx asks for 32 bytes; a test needs no secret.
    secretKey: 'x'.repeat(32),
    realm: REALM,
  });
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('authorization')) {
      const instead = options.instead?.(request);
      if (instead) return instead;
    }
    const result = await server.charge({
      amount: options.amount ?? '0.01',
      ...(options.splits ? { splits: options.splits } : {}),
      ...(options.expiresInMs !== undefined
        ? { expires: new Date(Date.now() + options.expiresInMs).toISOString() }
        : {}),
    } as never)(request);
    if (result.status === 402) return result.challenge as Response;
    const settled = result as unknown as { withReceipt: (response: Response) => Response };
    return options.after
      ? options.after(settled)
      : settled.withReceipt(Response.json({ temperature: 21 }));
  };
}
