// RPC faults on the call batch paths of the viem adapter (issue #317): a wallet's `wallet_sendCalls` and
// `wallet_getCallsStatus`, and viem's fallback through plain transactions, whose transactions are confirmed in the
// background. Anvil has no `wallet_*` methods: a stand-in wallet answers them, in front of the fault proxy. Each row
// makes the checks of `rpc-faults.int.test.ts` (fault-checks.ts): the caller's outcome is the one of a client without
// hashspan, no unhandled rejection, `flush()` resolves true, the spans end as pinned and metrics count each call once.
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { type Address, createWalletClient, custom, type Hex, http, RpcRequestError } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  collectingRejections,
  type Ending,
  expectEnding,
  type Faults,
  failed,
  faultsOn,
  NO_OUTCOME,
  type Outcome,
  recordingMeterProvider,
  SEND_ERROR_TYPES,
  settle,
  succeeded,
  TIMEOUT,
} from './fault-checks.js';
import { type FaultProxy, startFaultProxy } from './fault-proxy.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast, viemHasAction } from './viem-version.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const OTHER = '0x00000000000000000000000000000000000000cd' as const;
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const LOCAL_ACCOUNT = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
const REQUEST_TIMEOUT_MS = 1_000;
const WAIT_TIMEOUT_MS = 2_500;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

let proxy: FaultProxy;
let tracing: TestTracing;
let unlocked: Address;

beforeAll(async () => {
  proxy = await startFaultProxy(RPC_URL);
  [unlocked] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await proxy.stop();
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const proxied = () => http(proxy.url, { retryCount: 0, timeout: REQUEST_TIMEOUT_MS });
const spansNamed = (prefix: string): ReadableSpan[] =>
  tracing.spans().filter((s) => s.name.startsWith(prefix));

type WalletFault = 'fails' | 'fails once' | 'stays pending';

/**
 * A stand-in EIP-5792 wallet in front of the fault proxy: it sends a batch's first call as one transaction from the
 * unlocked account and reports that transaction's receipt as the batch status. `faults` makes its own methods fail
 * with a JSON-RPC internal error, once or always, or report a batch that stays pending.
 */
function standInWallet(
  faults: Partial<Record<'wallet_sendCalls' | 'wallet_getCallsStatus', WalletFault>>,
) {
  const upstream = proxied()({ chain: anvil });
  const batches = new Map<string, Hex>();
  const calls = new Map<string, number>();
  const fail = (method: string): boolean => {
    const count = (calls.get(method) ?? 0) + 1;
    calls.set(method, count);
    const fault = faults[method as keyof typeof faults];
    return fault === 'fails' || (fault === 'fails once' && count === 1);
  };
  const internalError = (method: string) =>
    new RpcRequestError({
      body: { method },
      error: { code: -32603, message: 'internal error' },
      url: 'wallet',
    });
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === 'wallet_sendCalls') {
        if (fail(method)) throw internalError(method);
        const [{ calls: batch, from }] = params as [
          { calls: { to: Hex; value?: Hex }[]; from: Hex },
        ];
        const hash = (await upstream.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: batch[0]?.to, value: batch[0]?.value }],
        } as never)) as Hex;
        const id = `0x${(batches.size + 1).toString(16).padStart(64, '0')}`;
        batches.set(id, hash);
        return { id };
      }
      if (method === 'wallet_getCallsStatus') {
        if (fail(method)) throw internalError(method);
        const id = String((params as unknown[])[0]);
        const receipt =
          faults.wallet_getCallsStatus === 'stays pending'
            ? null
            : await upstream.request({
                method: 'eth_getTransactionReceipt',
                params: [batches.get(id)],
              } as never);
        return {
          version: '2.0.0',
          id,
          chainId: '0x7a69',
          atomic: true,
          status: receipt ? 200 : 100,
          receipts: receipt ? [receipt] : [],
        };
      }
      return upstream.request({ method, params } as never);
    },
  });
}

/** What a caller got, without what differs between runs (hashes, blocks, batch ids). */
const shape = (outcome: Outcome | undefined) =>
  outcome === undefined
    ? undefined
    : 'rejected' in outcome
      ? outcome
      : { resolved: (outcome.resolved as { status?: unknown } | undefined)?.status ?? 'value' };

const BATCH_STATUS = 'blockchain.call_batch.status';
const TX_STATUS = 'blockchain.tx.status';

// sendCalls and waitForCallsStatus came with viem 2.28.0 (docs/adr/0022-call-batches.md).
describe.skipIf(!viemHasAction('waitForCallsStatus'))("a wallet's call batch methods", () => {
  // viem's waitForCallsStatus keeps polling through failed status requests until its timeout.
  const rows: Record<
    string,
    { faults: Parameters<typeof standInWallet>[0]; send: Ending; confirm?: Ending }
  > = {
    'wallet_sendCalls fails': {
      faults: { wallet_sendCalls: 'fails' },
      // The wallet's JSON-RPC error, under viem's TransactionExecutionError.
      send: failed('InternalRpcError'),
    },
    'wallet_getCallsStatus fails': {
      faults: { wallet_getCallsStatus: 'fails' },
      send: NO_OUTCOME,
      confirm: TIMEOUT,
    },
    'wallet_getCallsStatus fails once': {
      faults: { wallet_getCallsStatus: 'fails once' },
      send: NO_OUTCOME,
      confirm: succeeded('success'),
    },
    'the batch stays pending': {
      faults: { wallet_getCallsStatus: 'stays pending' },
      send: NO_OUTCOME,
      confirm: TIMEOUT,
    },
  };

  it.each(Object.keys(rows))('%s', async (row) => {
    const { faults, send, confirm } = rows[row] as (typeof rows)[string];
    const run = async (traced: boolean) => {
      proxy.set({});
      const meters = recordingMeterProvider();
      const hashspan = withHashspan({ meterProvider: meters.provider });
      const plain = createWalletClient({
        account: unlocked,
        chain: anvil,
        transport: standInWallet(faults),
        pollingInterval: 50,
      });
      const wallet = traced ? plain.extend(hashspan) : plain;
      const sent = await settle(wallet.sendCalls({ calls: [{ to: RECIPIENT, value: 1n }] }));
      const id = 'resolved' in sent ? (sent.resolved as { id: string }).id : undefined;
      const waited = id
        ? await settle(
            wallet.waitForCallsStatus({ id, timeout: WAIT_TIMEOUT_MS, pollingInterval: 50 }),
          )
        : undefined;
      return { sent, waited, meters, flushed: await hashspan.flush({ timeoutMs: 5_000 }) };
    };
    const untraced = await run(false);
    const [traced, rejections] = await collectingRejections(() => run(true));

    expect([shape(traced.sent), shape(traced.waited)]).toEqual([
      shape(untraced.sent),
      shape(untraced.waited),
    ]);
    expect(rejections).toEqual([]);
    expect(traced.flushed).toBe(true);
    expect(spansNamed('send ')).toHaveLength(1);
    expectEnding(spansNamed('send ')[0], send, BATCH_STATUS);
    expect(spansNamed('confirm ')).toHaveLength(confirm ? 1 : 0);
    if (confirm) expectEnding(spansNamed('confirm ')[0], confirm, BATCH_STATUS);
    expect(traced.meters.recorded('blockchain.client.send.duration')).toHaveLength(1);
    expect(traced.meters.recorded('blockchain.client.confirmation.duration')).toHaveLength(
      confirm ? 1 : 0,
    );
  });
});

// The fallback's transactions go through sendCallsSync's path from viem 2.45.2 (the viem README, call batches).
describe.skipIf(!viemAtLeast('2.45.2'))("viem's fallback through plain transactions", () => {
  /** Sends a two-call batch through the fallback; `faults` apply to the send, or only afterwards. */
  const run = async (traced: boolean, faults: Faults, during: 'send' | 'confirmations') => {
    const meters = recordingMeterProvider();
    const hashspan = withHashspan({
      meterProvider: meters.provider,
      confirm: { mode: 'background', timeoutMs: WAIT_TIMEOUT_MS },
    });
    const plain = createWalletClient({
      account: LOCAL_ACCOUNT,
      chain: anvil,
      transport: proxied(),
      pollingInterval: 50,
    });
    const wallet = traced ? plain.extend(hashspan) : plain;
    proxy.set(during === 'send' ? faults : {});
    const sent = await settle(
      wallet.sendCalls({
        calls: [
          { to: RECIPIENT, value: 1n },
          { to: OTHER, value: 2n },
        ],
        experimental_fallback: true,
      }),
    );
    proxy.set(faults);
    return { sent, meters, flushed: await hashspan.flush({ timeoutMs: 10_000 }) };
  };

  // A failed raw send reaches the caller wrapped by viem; the batch's send span records the error under the wrapper.
  it.each(Object.entries(faultsOn('eth_sendRawTransaction')))(
    'sending: %s',
    async (fault, faults) => {
      const untraced = await run(false, faults, 'send');
      const [traced, rejections] = await collectingRejections(() => run(true, faults, 'send'));

      expect(traced.sent).toEqual(untraced.sent);
      expect(rejections).toEqual([]);
      expect(traced.flushed).toBe(true);
      expect(spansNamed('send ')).toHaveLength(1);
      expectEnding(spansNamed('send ')[0], failed(SEND_ERROR_TYPES[fault] as string), BATCH_STATUS);
      expect(spansNamed('confirm ')).toHaveLength(0);
      expect(traced.meters.recorded('blockchain.client.send.duration')).toHaveLength(1);
    },
  );

  // Each fallback transaction is confirmed in the background, polling through failed receipt requests until its
  // timeout (docs/adr/0022-call-batches.md).
  it.each(Object.entries(faultsOn('eth_getTransactionReceipt')))(
    'confirming: %s',
    async (_fault, faults) => {
      const [traced, rejections] = await collectingRejections(() =>
        run(true, faults, 'confirmations'),
      );

      expect(traced.sent).toEqual({
        resolved: expect.objectContaining({ id: expect.any(String) }),
      });
      expect(rejections).toEqual([]);
      expect(traced.flushed).toBe(true);
      expect(spansNamed('send ')).toHaveLength(1);
      expectEnding(spansNamed('send ')[0], NO_OUTCOME, BATCH_STATUS);
      const confirms = spansNamed('confirm ');
      expect(confirms).toHaveLength(2);
      for (const confirm of confirms) expectEnding(confirm, TIMEOUT, TX_STATUS);
      expect(traced.meters.recorded('blockchain.client.confirmation.duration')).toHaveLength(2);
    },
  );
});
