// The JSON-RPC requests the viem adapter adds to a call (issue #334), counted on Anvil against the same calls without
// hashspan, so that a change that adds requests fails here. Agents often run against rate-limited endpoints; the
// requests per case are listed in docs/architecture.md. Counts only, no timing.
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, custom, type Hex, http } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { freePort } from './free-port.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
/** Runtime bytecode that always reverts without data: PUSH1 0 PUSH1 0 REVERT. */
const REVERTER = '0x00000000000000000000000000000000000000aa' as const;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  await instance.start();
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
  await createPublicClient({ chain: anvil, transport: http(RPC_URL) }).request({
    method: 'anvil_setCode' as never,
    params: [REVERTER, '0x60006000fd'] as never,
  });
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

type Counts = Record<string, number>;

/** A transport to Anvil that counts the requests per method. */
function counting(): { transport: ReturnType<typeof custom>; counts: Counts } {
  const counts: Counts = {};
  const upstream = http(RPC_URL)({ chain: anvil });
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      counts[method] = (counts[method] ?? 0) + 1;
      return upstream.request({ method, params } as never);
    },
  });
  return { transport, counts };
}

/** What `minuend` has more of than `subtrahend`, per method. */
function difference(minuend: Counts, subtrahend: Counts): Counts {
  const extra: Counts = {};
  for (const method of new Set([...Object.keys(minuend), ...Object.keys(subtrahend)])) {
    const more = (minuend[method] ?? 0) - (subtrahend[method] ?? 0);
    if (more !== 0) extra[method] = more;
  }
  return extra;
}

interface Clients {
  wallet: ReturnType<typeof createWalletClient>;
  reader: ReturnType<typeof createPublicClient>;
}

/**
 * Runs `scenario` once on clients without hashspan and once on clients extended with `withHashspan(options)`, and
 * returns the requests the traced run made in addition.
 */
async function extraRequests(
  scenario: (clients: Clients) => Promise<unknown>,
  options: { hashspan?: Parameters<typeof withHashspan>[0]; chain?: boolean } = {},
): Promise<Counts> {
  const run = async (traced: boolean) => {
    const { transport, counts } = counting();
    const hashspan = withHashspan(options.hashspan);
    const wallet = createWalletClient({
      account,
      chain: options.chain === false ? undefined : anvil,
      transport,
      pollingInterval: 50,
    });
    const reader = createPublicClient({ chain: anvil, transport, pollingInterval: 50 });
    await scenario(
      traced
        ? ({
            wallet: wallet.extend(hashspan),
            reader: reader.extend(hashspan),
          } as unknown as Clients)
        : ({ wallet, reader } as unknown as Clients),
    );
    await expect(hashspan.flush()).resolves.toBe(true);
    return counts;
  };
  const untraced = await run(false);
  return difference(await run(true), untraced);
}

const send = ({ wallet }: Clients, to: Address = RECIPIENT): Promise<Hex> =>
  wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to,
    value: to === RECIPIENT ? 1n : 0n,
    gas: 100_000n,
  });
const sendAndWait = async (clients: Clients, to?: Address) =>
  clients.reader.waitForTransactionReceipt({ hash: await send(clients, to) });

describe('JSON-RPC requests the viem adapter adds', () => {
  it('none to a send and its wait on a client with a chain', async () => {
    expect(await extraRequests(sendAndWait)).toEqual({});
  });

  it('one eth_chainId per send on a client without a chain', async () => {
    expect(await extraRequests(sendAndWait, { chain: false })).toEqual({ eth_chainId: 1 });
  });

  it('for background confirmation, only the requests of a receipt wait', async () => {
    const extra = await extraRequests(send, { hashspan: { confirm: { mode: 'background' } } });
    // The methods a caller's own wait uses, measured without hashspan. How often viem polls them depends on when
    // blocks arrive, so the methods are pinned, not the number of polls.
    const wait = difference(await measure(sendAndWait), await measure(send));
    expect(Object.keys(extra).every((method) => method in wait)).toBe(true);
    expect(extra.eth_getTransactionReceipt).toBeGreaterThanOrEqual(1);
  });

  it('for a reverted transaction, one transaction read and one call to replay it', async () => {
    const revert = (clients: Clients) => sendAndWait(clients, REVERTER);
    expect(await extraRequests(revert)).toEqual({ eth_getTransactionByHash: 1, eth_call: 1 });
    expect(tracing.spans().some((s) => s.attributes['blockchain.tx.status'] === 'reverted')).toBe(
      true,
    );
  });

  it('none for a reverted transaction with decodeRevertReason off', async () => {
    const revert = (clients: Clients) => sendAndWait(clients, REVERTER);
    expect(await extraRequests(revert, { hashspan: { decodeRevertReason: false } })).toEqual({});
  });
});

/** The requests `scenario` makes without hashspan. */
async function measure(scenario: (clients: Clients) => Promise<unknown>): Promise<Counts> {
  const { transport, counts } = counting();
  const wallet = createWalletClient({ account, chain: anvil, transport, pollingInterval: 50 });
  const reader = createPublicClient({ chain: anvil, transport, pollingInterval: 50 });
  await scenario({ wallet, reader } as unknown as Clients);
  return counts;
}
