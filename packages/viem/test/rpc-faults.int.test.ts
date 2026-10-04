// RPC faults on the transaction send and confirm paths of the viem adapter (sendTransaction, writeContract, the
// caller's waitForTransactionReceipt, background confirmation, watch()), injected by a proxy in front of Anvil
// (`fault-proxy.ts`). Call batches are in `call-batch-faults.int.test.ts`, the bundler methods of user operations in
// `user-operation.int.test.ts`. For each fault and path it checks that:
// 1. the caller's call returns or throws as it does on a client without hashspan;
// 2. the span ends with the status and `error.type` of docs/semconv.md (Span status);
// 3. no unhandled rejection occurs;
// 4. pending work ends (`flush()` resolves true), a background slot is released, and metrics count the call once.
// Each row pins how the span ends today. A row whose ending is a defect also has an `it.fails` test with the ending
// it should have, tagged with its issue (`// finding: #<issue>`); fixing the defect turns it into `it`.
import {
  type Attributes,
  type Histogram,
  type MeterProvider,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  parseAbi,
} from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { type Fault, type FaultProxy, type FaultRule, startFaultProxy } from './fault-proxy.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
/** viem's request timeout on the proxied transports, so a request that never answers fails fast. */
const REQUEST_TIMEOUT_MS = 1_000;
/** How long a wait, `watch()` or background confirmation polls before it gives up. */
const WAIT_TIMEOUT_MS = 2_500;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

let proxy: FaultProxy;
let tracing: TestTracing;
let account: Address;

/** Untraced client straight to Anvil, for setting up and checking the chain. */
const control = createPublicClient({ chain: anvil, transport: http(RPC_URL), pollingInterval: 50 });

beforeAll(async () => {
  proxy = await startFaultProxy(RPC_URL);
  [account] = (await createWalletClient({
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

type Faults = Record<string, Fault | FaultRule | FaultRule[]>;

/** A transport through the proxy without viem's retries, so each fault reaches the caller as the node sent it. */
const proxied = () => http(proxy.url, { retryCount: 0, timeout: REQUEST_TIMEOUT_MS });

/** A meter provider that keeps what each histogram records. */
function recordingMeterProvider() {
  const recorded = new Map<string, { value: number; attributes: Attributes }[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return {
          record: (value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push({ value, attributes });
          },
        };
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

type Outcome =
  | { resolved: unknown }
  | { rejected: { name: unknown; shortMessage: unknown; details: unknown } };

/** How a call settled, comparable between a client with hashspan and one without. */
const settle = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (resolved) => ({ resolved }),
    (error: { name?: unknown; shortMessage?: unknown; details?: unknown }) => ({
      rejected: { name: error.name, shortMessage: error.shortMessage, details: error.details },
    }),
  );

/** Runs `run`, collecting the unhandled rejections raised until a little after it settled. */
async function collectingRejections<T>(run: () => Promise<T>): Promise<[T, unknown[]]> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [result, rejections];
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

const spansNamed = (prefix: string): ReadableSpan[] =>
  tracing.spans().filter((s) => s.name.startsWith(prefix));

/** How a span ended: its status code, `error.type` and `blockchain.tx.status`. */
interface Ending {
  status: SpanStatusCode;
  errorType?: string;
  txStatus?: string;
}
const failed = (errorType: string): Ending => ({ status: SpanStatusCode.ERROR, errorType });
const TIMEOUT = failed('timeout');
const SUCCESS: Ending = { status: SpanStatusCode.UNSET, txStatus: 'success' };
/** Ended without an error and without an outcome. */
const NO_OUTCOME: Ending = { status: SpanStatusCode.UNSET };

const expectEnding = (span: ReadableSpan | undefined, ending: Ending): void =>
  expect({
    status: span?.status.code,
    errorType: span?.attributes['error.type'],
    txStatus: span?.attributes['blockchain.tx.status'],
  }).toEqual({ status: ending.status, errorType: ending.errorType, txStatus: ending.txStatus });

/** A transfer mined by a client without hashspan, straight to Anvil. */
async function minedTransfer(): Promise<Hex> {
  const hash = await createWalletClient({
    account,
    chain: anvil,
    transport: http(RPC_URL),
  }).sendTransaction({ to: RECIPIENT, value: 1n });
  await control.waitForTransactionReceipt({ hash });
  return hash;
}

type TransportFault =
  | 'a request that never answers'
  | 'HTTP 429'
  | 'JSON-RPC -32005 (limit exceeded)'
  | 'JSON-RPC -32603 (internal error)'
  | 'a connection reset mid-response';

/** The transport faults of issue #290, on `method`. */
const faultsOn = (method: string): Record<TransportFault, Faults> => ({
  'a request that never answers': { [method]: { kind: 'hang' } },
  'HTTP 429': { [method]: { kind: 'http', status: 429 } },
  'JSON-RPC -32005 (limit exceeded)': { [method]: { kind: 'rpc-error', code: -32005 } },
  'JSON-RPC -32603 (internal error)': { [method]: { kind: 'rpc-error', code: -32603 } },
  'a connection reset mid-response': { [method]: { kind: 'reset' } },
});

// --- sends -------------------------------------------------------------------------------------------------------

const transfer = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

describe.each([
  ['sendTransaction', 'a client with a chain', anvil],
  ['sendTransaction', 'a client without a chain', null],
  ['writeContract', 'a client with a chain', anvil],
] as const)('%s on %s', (action, _, chain) => {
  const wallet = () =>
    createWalletClient({ account, chain: chain ?? undefined, transport: proxied() });
  const send = (client: ReturnType<typeof wallet>) =>
    action === 'sendTransaction'
      ? client.sendTransaction({ to: RECIPIENT, value: 1n, chain })
      : client.writeContract({
          address: RECIPIENT,
          abi: transfer,
          functionName: 'transfer',
          args: [RECIPIENT, 1n],
          chain,
        });

  // A failed send records the error the caller got, by class name; viem wraps every send error in a
  // TransactionExecutionError (ContractFunctionExecutionError for writeContract).
  const wrapped =
    action === 'sendTransaction' ? 'TransactionExecutionError' : 'ContractFunctionExecutionError';

  it.each(Object.entries(faultsOn('eth_sendTransaction')))('%s', async (_fault, faults) => {
    proxy.set(faults);
    const untraced = await settle(send(wallet()));
    expect(untraced).toMatchObject({ rejected: { name: wrapped } });

    const [{ outcome, meters, flushed }, rejections] = await collectingRejections(async () => {
      proxy.set(faults);
      const meters = recordingMeterProvider();
      const hashspan = withHashspan({ meterProvider: meters.provider });
      const outcome = await settle(send(wallet().extend(hashspan)));
      return { outcome, meters, flushed: await hashspan.flush({ timeoutMs: 5_000 }) };
    });

    expect(outcome).toEqual(untraced);
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    expect(spansNamed('send ').map((s) => s.name)).toEqual(['send 31337']);
    expectEnding(spansNamed('send ')[0], failed(wrapped));
    expect(meters.recorded('blockchain.client.send.duration')).toHaveLength(1);
  });
});

describe('a chain id that changes between calls', () => {
  /** `eth_chainId` answers Anvil's chain id once, then 1. */
  const changingChainId: Faults = {
    eth_chainId: { kind: 'result', result: (chainId, call) => (call === 1 ? chainId : '0x1') },
  };

  it('fails the second send on a client with a chain, as viem does', async () => {
    const sendTwice = async (traced: boolean) => {
      proxy.set(changingChainId);
      const plain = createWalletClient({ account, chain: anvil, transport: proxied() });
      const wallet = traced ? plain.extend(withHashspan()) : plain;
      return [
        await settle(wallet.sendTransaction({ to: RECIPIENT, value: 1n })),
        await settle(wallet.sendTransaction({ to: RECIPIENT, value: 1n })),
      ];
    };
    const untraced = await sendTwice(false);
    expect(untraced[0]).toHaveProperty('resolved');
    expect(untraced[1]).toMatchObject({ rejected: { name: 'TransactionExecutionError' } });

    const [traced, rejections] = await collectingRejections(() => sendTwice(true));
    expect(traced[0]).toHaveProperty('resolved');
    expect(traced[1]).toEqual(untraced[1]);
    expect(rejections).toEqual([]);
    const sends = spansNamed('send ');
    expect(sends.map((s) => s.name)).toEqual(['send 31337', 'send 31337']);
    expectEnding(sends[0], NO_OUTCOME);
    expectEnding(sends[1], failed('TransactionExecutionError'));
  });

  it('records each send of a client without a chain on the chain the node named for it', async () => {
    proxy.set(changingChainId);
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, transport: proxied() }).extend(hashspan);
    const [hashes, rejections] = await collectingRejections(async () => [
      await wallet.sendTransaction({ to: RECIPIENT, value: 1n, chain: null }),
      await wallet.sendTransaction({ to: RECIPIENT, value: 1n, chain: null }),
    ]);
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(rejections).toEqual([]);
    // The adapter asks a client without a chain for each send, as such a client may switch chains.
    expect(proxy.requests('eth_chainId')).toBe(2);
    expect(spansNamed('send ').map((s) => s.attributes['blockchain.tx.hash'])).toEqual(hashes);
    expect(spansNamed('send ').map((s) => s.name)).toEqual(['send 31337', 'send 1']);
    for (const send of spansNamed('send ')) expectEnding(send, NO_OUTCOME);
  });
});

// --- confirmations -----------------------------------------------------------------------------------------------

const RECEIPT = 'eth_getTransactionReceipt';

/** Faults on the receipt requests of a confirmation, and on what viem reads besides them. */
const confirmFaults = {
  ...faultsOn(RECEIPT),
  'a receipt that stays null': { [RECEIPT]: { kind: 'result', result: () => null } },
  'a malformed receipt': {
    [RECEIPT]: {
      kind: 'result',
      result: (receipt) => (receipt ? { ...(receipt as object), blockNumber: '0xzz' } : receipt),
    },
  },
  'a receipt that is not an object': { [RECEIPT]: { kind: 'result', result: () => '0x1' } },
  'a malformed block, while the receipt stays null': {
    [RECEIPT]: { kind: 'result', result: () => null },
    eth_getBlockByNumber: {
      kind: 'result',
      result: (block) => ({ ...(block as object), number: '0xzz', transactions: 'none' }),
    },
  },
  'block numbers answered out of order': { eth_blockNumber: { kind: 'previous' } },
  // The first receipt request finds none, the second fails, later ones find the receipt.
  'one failed receipt request between good ones': {
    [RECEIPT]: [
      { fault: { kind: 'result', result: () => null }, times: 1 },
      { fault: { kind: 'rpc-error', code: -32603 }, after: 1, times: 1 },
    ],
  },
} satisfies Record<string, Faults>;
type ConfirmFault = keyof typeof confirmFaults;

/** How a confirm span ends today, and, for a defect, how it should end. */
type Row = Ending | { now: Ending; finding: string; should: Ending };
const now = (row: Row): Ending => ('now' in row ? row.now : row);
/** Confirmation duration samples a confirmation records: one, unless its span ended without an outcome. */
const samples = (ending: Ending): number => (ending === NO_OUTCOME ? 0 : 1);

// A result that is not a receipt ends the confirm span as a failure, with one confirmation sample (#311).
const NOT_A_RECEIPT: Row = failed('_OTHER');

describe("the caller's waitForTransactionReceipt", () => {
  // The span records the error the caller got, by class name (docs/semconv.md, Span status).
  const rows: Record<ConfirmFault, Row> = {
    'a request that never answers': failed('TimeoutError'),
    'HTTP 429': failed('HttpRequestError'),
    'JSON-RPC -32005 (limit exceeded)': failed('LimitExceededRpcError'),
    'JSON-RPC -32603 (internal error)': failed('InternalRpcError'),
    'a connection reset mid-response': failed('HttpRequestError'),
    'a receipt that stays null': failed('TransactionReceiptNotFoundError'),
    'a malformed receipt': failed('SyntaxError'),
    'a receipt that is not an object': NOT_A_RECEIPT,
    'a malformed block, while the receipt stays null': failed('TypeError'),
    'block numbers answered out of order': SUCCESS,
    // viem's own wait ends on any error that is not a missing receipt; the span follows the caller's result.
    'one failed receipt request between good ones': failed('InternalRpcError'),
  };
  const reader = () =>
    createPublicClient({ chain: anvil, transport: proxied(), pollingInterval: 50 });
  const wait = (
    client: { waitForTransactionReceipt: (args: never) => Promise<unknown> },
    hash: Hex,
  ) =>
    settle(
      client.waitForTransactionReceipt({
        hash,
        timeout: WAIT_TIMEOUT_MS,
        retryCount: 0,
        retryDelay: 10,
      } as never),
    );

  async function tracedWait(fault: ConfirmFault, hash: Hex) {
    return collectingRejections(async () => {
      proxy.set(confirmFaults[fault]);
      const meters = recordingMeterProvider();
      const hashspan = withHashspan({ meterProvider: meters.provider });
      const outcome = await wait(reader().extend(hashspan), hash);
      return { outcome, meters, flushed: await hashspan.flush({ timeoutMs: 5_000 }) };
    });
  }

  it.each(Object.keys(rows) as ConfirmFault[])('%s', async (fault) => {
    const hash = await minedTransfer();
    proxy.set(confirmFaults[fault]);
    const untraced = await wait(reader(), hash);

    const [{ outcome, meters, flushed }, rejections] = await tracedWait(fault, hash);

    expect(outcome).toEqual(untraced);
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    expect(spansNamed('confirm ')).toHaveLength(1);
    expectEnding(spansNamed('confirm ')[0], now(rows[fault]));
    expect(meters.recorded('blockchain.client.confirmation.duration')).toHaveLength(
      samples(now(rows[fault])),
    );
  });

  for (const [fault, row] of Object.entries(rows) as [ConfirmFault, Row][]) {
    if (!('finding' in row)) continue;
    // finding: see the row's issue.
    it.fails(`${fault}: ends as it should [finding: ${row.finding}]`, async () => {
      await tracedWait(fault, await minedTransfer());
      expectEnding(spansNamed('confirm ')[0], row.should);
    });
  }

  it('records the receipt of another transaction that a mixed-up response returned as a replacement', async () => {
    const first = await minedTransfer();
    const second = await minedTransfer();
    /** Waits for both transactions in turn while each receipt request gets the previous one's answer. */
    const waitForBoth = async (client: ReturnType<typeof reader>) => {
      proxy.set({ [RECEIPT]: { kind: 'previous' } });
      return [await wait(client, first), await wait(client, second)];
    };
    const untraced = await waitForBoth(reader());
    // viem returns the first transaction's receipt to the wait for the second.
    expect(untraced[1]).toMatchObject({ resolved: { transactionHash: first } });

    const hashspan = withHashspan();
    const [traced, rejections] = await collectingRejections(() =>
      waitForBoth(reader().extend(hashspan)),
    );
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(traced).toEqual(untraced);
    expect(rejections).toEqual([]);
    // The tracker attributes a receipt of another hash as a replacement (ADR 0008), though none was reported.
    const confirms = spansNamed('confirm ');
    expect(confirms).toHaveLength(2);
    const ofSecond = confirms.find((s) => s.attributes['blockchain.tx.hash'] === second);
    expect(ofSecond?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': first,
    });
  });
});

describe.each(['background confirmation', 'watch()'] as const)('%s', (path) => {
  // Background confirmation and watch() poll through viem's wait as well. They wait again after a missing receipt or
  // a failed request, one polling interval later, until their timeout: a fault that lasts ends as a timeout.
  const rows: Record<ConfirmFault, Row> = {
    'a request that never answers': TIMEOUT,
    'HTTP 429': TIMEOUT,
    'JSON-RPC -32005 (limit exceeded)': TIMEOUT,
    'JSON-RPC -32603 (internal error)': TIMEOUT,
    'a connection reset mid-response': TIMEOUT,
    'a receipt that stays null': TIMEOUT,
    'a malformed receipt': TIMEOUT,
    'a receipt that is not an object': NOT_A_RECEIPT,
    'a malformed block, while the receipt stays null': TIMEOUT,
    'block numbers answered out of order': SUCCESS,
    'one failed receipt request between good ones': SUCCESS,
  };

  /** Confirms one transfer on `path` under `faults`. */
  async function confirmOnce(
    faults: Faults,
    hashspan: ReturnType<typeof withHashspan>,
  ): Promise<{
    sent?: Outcome | undefined;
    onReceipt: ReturnType<typeof vi.fn>;
    flushed: boolean;
  }> {
    const onReceipt = vi.fn();
    let sent: Outcome | undefined;
    if (path === 'background confirmation') {
      proxy.set(faults);
      const wallet = createWalletClient({
        account,
        chain: anvil,
        transport: proxied(),
        pollingInterval: 50,
      }).extend(hashspan);
      sent = await settle(wallet.sendTransaction({ to: RECIPIENT, value: 1n }));
    } else {
      const hash = await minedTransfer();
      proxy.set(faults);
      const reader = createPublicClient({
        chain: anvil,
        transport: proxied(),
        pollingInterval: 50,
      });
      hashspan.watch(reader, { hash, timeoutMs: WAIT_TIMEOUT_MS, onReceipt });
    }
    return { sent, onReceipt, flushed: await hashspan.flush({ timeoutMs: 10_000 }) };
  }
  /** At most one background confirmation at a time, so a slot that is not released shows. */
  const limitedTo1 = (meterProvider?: MeterProvider) =>
    withHashspan({
      meterProvider,
      maxBackgroundConfirmations: 1,
      confirm: { mode: 'background', timeoutMs: WAIT_TIMEOUT_MS },
    });

  it.each(Object.keys(rows) as ConfirmFault[])('%s', async (fault) => {
    const meters = recordingMeterProvider();
    const hashspan = limitedTo1(meters.provider);
    const [{ sent, onReceipt, flushed }, rejections] = await collectingRejections(() =>
      confirmOnce(confirmFaults[fault], hashspan),
    );

    if (path === 'background confirmation') {
      // Faults on receipts leave the send untouched.
      expect(sent).toEqual({ resolved: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    } else {
      // Called once: with what viem resolved, or with undefined when the watch failed. viem resolves a result that is
      // not a receipt, which the span cannot record (#311): onReceipt still gets what viem resolved.
      expect(onReceipt).toHaveBeenCalledOnce();
      const failedWatch =
        now(rows[fault]).status === SpanStatusCode.ERROR &&
        fault !== 'a receipt that is not an object';
      expect(onReceipt.mock.calls[0]?.[0] === undefined).toBe(failedWatch);
    }
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    expect(spansNamed('confirm ')).toHaveLength(1);
    expectEnding(spansNamed('confirm ')[0], now(rows[fault]));
    expect(meters.recorded('blockchain.client.confirmation.duration')).toHaveLength(
      samples(now(rows[fault])),
    );

    // The confirmation released its slot: with a limit of one, the next one is still recorded.
    await confirmOnce({}, hashspan);
    expect(spansNamed('confirm ')).toHaveLength(2);
    expectEnding(spansNamed('confirm ')[1], SUCCESS);
  });

  for (const [fault, row] of Object.entries(rows) as [ConfirmFault, Row][]) {
    if (!('finding' in row)) continue;
    // finding: see the row's issue.
    it.fails(`${fault}: ends as it should [finding: ${row.finding}]`, async () => {
      await confirmOnce(confirmFaults[fault], limitedTo1());
      expectEnding(spansNamed('confirm ')[0], row.should);
    });
  }
});
