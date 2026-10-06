// The JSON-RPC requests the viem adapter adds to a call (issue #334), counted on Anvil against the same calls without
// hashspan, so that a change that adds requests fails here. Agents often run against rate-limited endpoints; the
// requests per case are listed in docs/architecture.md. Counts only, no timing.
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, custom, type Hex, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { freePort } from './free-port.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
/** Runtime bytecode that always reverts without data: PUSH1 0 PUSH1 0 REVERT. */
const REVERTER = '0x00000000000000000000000000000000000000aa' as const;
/** The OP Stack GasPriceOracle predeploy, which Anvil does not have: a stand-in is set there. */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;
/**
 * Runtime bytecode of the stand-in `getOperatorFee(uint256 gasUsed)`: returns `3 × gasUsed`, whatever the selector.
 * PUSH1 4 CALLDATALOAD PUSH1 3 MUL PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN.
 */
const OPERATOR_FEE_ORACLE = '0x60043560030260005260206000f3';

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
  // Before any transaction, so that the call at a receipt's block finds the code.
  await createPublicClient({ chain: anvil, transport: http(RPC_URL) }).request({
    method: 'anvil_setCode' as never,
    params: [GAS_PRICE_ORACLE, OPERATOR_FEE_ORACLE] as never,
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

/** A Tempo fee token, as a Tempo node names it on a receipt of type 0x76. */
const FEE_TOKEN = '0x20C0000000000000000000000000000000000001';
/** A Celo fee currency, as a sending call passes it. */
const FEE_CURRENCY = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

/** An account other than the sender that paid a Tempo transaction's fee. */
const FEE_PAYER = '0x3333333333333333333333333333333333333333';

/** How the counting transport makes Anvil's answers look like another chain's. */
type Shape = 'operatorFee' | 'tempo' | 'sponsored' | undefined;

/**
 * A transport to Anvil that counts the requests per method. With `operatorFee`, receipts carry the fields of an OP
 * Stack chain that charges an operator fee, as a node after Isthmus adds them; with `tempo`, they are of type `0x76`
 * and name a fee token, as a Tempo node's are, and with `sponsored` also a fee payer other than the sender. A Celo
 * `feeCurrency` is taken out of a sent transaction, which Anvil does not know.
 */
function counting(shape: Shape = undefined): {
  transport: ReturnType<typeof custom>;
  counts: Counts;
} {
  const counts: Counts = {};
  const upstream = http(RPC_URL)({ chain: anvil });
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      counts[method] = (counts[method] ?? 0) + 1;
      const sent =
        method === 'eth_sendTransaction' && Array.isArray(params)
          ? params.map((p) => {
              const { feeCurrency: _, ...rest } = p as Record<string, unknown>;
              return rest;
            })
          : params;
      const result = await upstream.request({ method, params: sent } as never);
      if (method !== 'eth_getTransactionReceipt' || !result) return result;
      if (shape === 'operatorFee')
        return { ...(result as object), operatorFeeScalar: '0x3e8', operatorFeeConstant: '0x0' };
      if (shape === 'tempo') return { ...(result as object), type: '0x76', feeToken: FEE_TOKEN };
      if (shape === 'sponsored')
        return { ...(result as object), type: '0x76', feeToken: FEE_TOKEN, feePayer: FEE_PAYER };
      return result;
    },
  });
  return { transport, counts };
}

/**
 * The methods a receipt wait polls: how often depends on when blocks arrive, so two runs of the same wait can differ
 * by a poll. Exact comparisons leave them out; the background confirmation test checks them by method.
 */
const POLLING = new Set(['eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber']);

/** What `minuend` has more of than `subtrahend`, per method; without polling methods if `polling` is false. */
function difference(minuend: Counts, subtrahend: Counts, polling = true): Counts {
  const extra: Counts = {};
  for (const method of new Set([...Object.keys(minuend), ...Object.keys(subtrahend)])) {
    if (!polling && POLLING.has(method)) continue;
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
  options: {
    hashspan?: Parameters<typeof withHashspan>[0];
    chain?: boolean;
    polling?: boolean;
    shape?: Shape;
  } = {},
): Promise<Counts> {
  const run = async (traced: boolean) => {
    const { transport, counts } = counting(options.shape);
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
  return difference(await run(true), untraced, options.polling ?? false);
}

const send = ({ wallet }: Clients, to: Address = RECIPIENT): Promise<Hex> =>
  wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to,
    value: to === RECIPIENT ? 1n : 0n,
    gas: 100_000n,
  });
/** Sends and waits at once, as an application does: the methods any receipt wait can use. */
const sendAndWaitAtOnce = async (clients: Clients, to?: Address) =>
  clients.reader.waitForTransactionReceipt({ hash: await send(clients, to) });

/**
 * Sends and waits for the receipt. Anvil can return the hash a moment before the block is mined; a wait that polls
 * before then also reads the transaction (viem's replacement check), so two runs could differ by an
 * `eth_getTransactionByHash`. The wait therefore starts once the receipt is there, and the extra receipt polls are
 * left out of the exact counts (see POLLING).
 */
const sendAndWait = async (clients: Clients, to?: Address) => {
  const hash = await send(clients, to);
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await clients.reader.getTransactionReceipt({ hash }).catch(() => undefined);
    if (receipt) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return clients.reader.waitForTransactionReceipt({ hash });
};

/**
 * Signs a transfer with Anvil's first account (its public test mnemonic) and broadcasts it with `sendRawTransaction`,
 * as a service whose transactions are signed elsewhere does; then waits as `sendAndWait` does.
 */
const rawSendAndWait = async (clients: Clients) => {
  const signer = mnemonicToAccount('test test test test test test test test test test test junk');
  const request = await clients.wallet.prepareTransactionRequest({
    account: signer,
    chain: anvil,
    to: RECIPIENT,
    value: 1n,
    gas: 100_000n,
  });
  const serializedTransaction = await signer.signTransaction(request as never);
  const hash = await clients.wallet.sendRawTransaction({ serializedTransaction });
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await clients.reader.getTransactionReceipt({ hash }).catch(() => undefined);
    if (receipt) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return clients.reader.waitForTransactionReceipt({ hash });
};

describe('JSON-RPC requests the viem adapter adds', () => {
  // Polling methods are left out of these exact counts (see POLLING); every other method is counted exactly.
  it('none to a send and its wait on a client with a chain', async () => {
    expect(await extraRequests(sendAndWait)).toEqual({});
    // Its receipt carries no operator fee fields: no operator fee is read or recorded.
    const confirm = tracing.spans().find((s) => s.name === `confirm ${anvil.id}`);
    expect(confirm?.attributes).not.toHaveProperty('blockchain.tx.operator_fee');
  });

  it('none to a raw send and its wait on a client with a chain', async () => {
    expect(await extraRequests(rawSendAndWait)).toEqual({});
    expect(tracing.spans().map((span) => span.name)).toContain(`send ${anvil.id}`);
  });

  it('one eth_chainId per send on a client without a chain', async () => {
    expect(await extraRequests(sendAndWait, { chain: false })).toEqual({ eth_chainId: 1 });
  });

  it('for background confirmation, only the requests of a receipt wait', async () => {
    const extra = await extraRequests(send, {
      hashspan: { confirm: { mode: 'background' } },
      polling: true,
    });
    // The methods a caller's own wait uses, measured without hashspan. How often viem polls them depends on when
    // blocks arrive, so the methods are pinned, not the number of polls.
    const wait = difference(await measure(sendAndWaitAtOnce), await measure(send));
    // A wait whose first poll finds no receipt also reads the transaction (viem's replacement check), whether or not
    // the measured wait happened to.
    const allowed = new Set([...Object.keys(wait), 'eth_getTransactionByHash']);
    expect(Object.keys(extra).every((method) => allowed.has(method))).toBe(true);
    expect(extra.eth_getTransactionReceipt).toBeGreaterThanOrEqual(1);
  });

  it('for a reverted transaction, one transaction read and one call to replay it', async () => {
    const revert = (clients: Clients) => sendAndWait(clients, REVERTER);
    expect(await extraRequests(revert)).toEqual({ eth_getTransactionByHash: 1, eth_call: 1 });
    expect(tracing.spans().some((s) => s.attributes['blockchain.tx.status'] === 'reverted')).toBe(
      true,
    );
  });

  // Before viem 2.33.0, a wait for several confirmations of a transaction already that deep waits for another block,
  // and this test mines none.
  it.skipIf(!viemAtLeast('2.33.0'))(
    'one eth_getTransactionReceipt for a wait for several confirmations',
    async () => {
      const direct = createPublicClient({ chain: anvil, transport: http(RPC_URL), cacheTime: 0 });
      /**
       * Waits for 2 confirmations of a mined transfer. The receipt is read and the next block mined outside the counted
       * transport first, so viem resolves on its first receipt request and both runs poll alike.
       */
      const waitFor2 = async (clients: Clients) => {
        const hash = await send(clients);
        await direct.waitForTransactionReceipt({ hash, pollingInterval: 10 });
        await direct.request({ method: 'evm_mine' as never });
        return clients.reader.waitForTransactionReceipt({ hash, confirmations: 2 });
      };
      // The receipt is read once more after the wait resolved; the block only when that receipt is missing or in
      // another block (docs/adr/0026-receipt-after-several-confirmations.md).
      expect(await extraRequests(waitFor2, { polling: true })).toEqual({
        eth_getTransactionReceipt: 1,
      });
    },
  );

  it('one eth_call for a receipt that charges an OP Stack operator fee', async () => {
    expect(await extraRequests(sendAndWait, { shape: 'operatorFee' })).toEqual({ eth_call: 1 });
    const confirm = tracing.spans().find((s) => s.name === `confirm ${anvil.id}`);
    // The stand-in oracle returns 3 × gasUsed; the fee keeps its meaning.
    expect(confirm?.attributes['blockchain.tx.operator_fee']).toBe(String(3 * 21_000));
    expect(confirm?.attributes['blockchain.tx.fee']).toBe(
      String(
        BigInt(confirm?.attributes['blockchain.tx.gas.used'] as number) *
          BigInt(confirm?.attributes['blockchain.tx.effective_gas_price'] as string),
      ),
    );
  });

  it('none for a fee paid in a Celo fee currency, read from the sending call', async () => {
    const sendInFeeCurrency = async (clients: Clients) => {
      const hash = await clients.wallet.sendTransaction({
        account,
        chain: anvil,
        to: RECIPIENT,
        value: 1n,
        gas: 100_000n,
        feeCurrency: FEE_CURRENCY,
      } as never);
      for (let attempt = 0; attempt < 100; attempt++) {
        const receipt = await clients.reader.getTransactionReceipt({ hash }).catch(() => undefined);
        if (receipt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return clients.reader.waitForTransactionReceipt({ hash });
    };
    expect(await extraRequests(sendInFeeCurrency)).toEqual({});
    const confirm = tracing.spans().find((s) => s.name === `confirm ${anvil.id}`);
    expect(confirm?.attributes['blockchain.tx.fee_asset']).toBe(FEE_CURRENCY.toLowerCase());
  });

  it('none for a fee paid in a Tempo fee token, read from a receipt of type 0x76', async () => {
    expect(await extraRequests(sendAndWait, { shape: 'tempo' })).toEqual({});
    const confirm = tracing.spans().find((s) => s.name === `confirm ${anvil.id}`);
    expect(confirm?.attributes['blockchain.tx.fee_asset']).toBe(FEE_TOKEN.toLowerCase());
  });

  it('none for a fee another account paid, read from the feePayer of a receipt of type 0x76', async () => {
    expect(await extraRequests(sendAndWait, { shape: 'sponsored' })).toEqual({});
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
