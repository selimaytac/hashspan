import { createTxTracker, METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION } from '@hashspan/core';
import { withHashspan as withViemHashspan } from '@hashspan/viem';
import {
  type Attributes,
  context,
  diag,
  type Histogram,
  type MeterProvider,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { createPublicClient, encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTransport } from '../../viem/test/mock-transport.js';
import { withHashspan } from '../src/index.js';
import { SentUserOperations, userOperationReceiptFromBundle } from '../src/user-operation.js';
import { setupTracing, type TestTracing } from './tracing.js';

const OP_HASH = `0x${'01'.repeat(32)}` as const;
const OTHER_OP_HASH = `0x${'02'.repeat(32)}` as const;
const BUNDLE = `0x${'ab'.repeat(32)}` as const;
const SMART = '0x5555555555555555555555555555555555555555';
const OTHER_SMART = '0x6666666666666666666666666666666666666666';
const OWNER = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const PAYMASTER = '0x7777777777777777777777777777777777777777';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const ZERO = '0x0000000000000000000000000000000000000000';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const broadcast = (smartAccountAddress = SMART, userOpHash: string = OP_HASH) => ({
  smartAccountAddress,
  status: 'broadcast',
  userOpHash,
});
const complete = {
  smartAccountAddress: SMART,
  status: 'complete',
  transactionHash: BUNDLE,
  userOpHash: OP_HASH,
};
const failed = { smartAccountAddress: SMART, status: 'failed', userOpHash: OP_HASH };

type Method = (options?: unknown) => Promise<unknown>;
type SmartAccount = Record<
  | 'sendUserOperation'
  | 'transfer'
  | 'swap'
  | 'useSpendPermission'
  | 'quoteSwap'
  | 'waitForUserOperation'
  | 'useNetwork',
  Method
> & { address: string };
type ScopedSmartAccount = Record<
  | 'sendUserOperation'
  | 'transfer'
  | 'swap'
  | 'useSpendPermission'
  | 'quoteSwap'
  | 'waitForUserOperation',
  Method
>;

/** How the fake SDK's waits answer: a result, or an error to reject with. */
interface WaitControl {
  wait: (options: unknown) => Promise<unknown>;
}

/** A swap quote for a smart account: `execute()` sends a user operation. */
function fakeQuote(network: string, sent: string[]) {
  return {
    liquidityAvailable: true,
    network,
    execute: async () => {
      sent.push('quote');
      return { userOpHash: OP_HASH, smartAccountAddress: SMART, status: 'broadcast' };
    },
  };
}

/**
 * A smart account shaped like the SDK's (`toEvmSmartAccount`): each send method sends its own user operation, and a
 * network-scoped account's `useSpendPermission` calls the account's.
 */
function fakeSmartAccount(sent: string[], waits: WaitControl, address = SMART) {
  const op = (name: string) => async (_opts?: unknown) => {
    sent.push(name);
    return broadcast(address);
  };
  const account: Record<string, unknown> & { address: string } = {
    address,
    owners: [{ address: OWNER }],
    type: 'evm-smart',
    sendUserOperation: op('sendUserOperation'),
    transfer: op('transfer'),
    swap: op('swap'),
    useSpendPermission: op('useSpendPermission'),
    async quoteSwap(opts: { network: string }) {
      return fakeQuote(opts.network, sent);
    },
    waitForUserOperation: (opts: unknown) => waits.wait(opts),
    async useNetwork(network: string) {
      return {
        address,
        network,
        type: 'evm-smart',
        sendUserOperation: op('scoped sendUserOperation'),
        transfer: op('scoped transfer'),
        swap: op('scoped swap'),
        quoteSwap: async () => fakeQuote(network, sent),
        useSpendPermission: (opts: object) =>
          (account.useSpendPermission as Method)({ ...opts, network }),
        waitForUserOperation: (opts: unknown) => waits.wait(opts),
      };
    },
  };
  return account;
}

type FakeEvm = Record<
  | 'createSmartAccount'
  | 'getSmartAccount'
  | 'getOrCreateSmartAccount'
  | 'updateSmartAccount'
  | 'listSmartAccounts'
  | 'sendUserOperation'
  | 'prepareAndSendUserOperation'
  | 'createSpendPermission'
  | 'revokeSpendPermission'
  | 'waitForUserOperation'
  | 'createSwapQuote',
  Method
>;

function fakeCdp(options: { sent?: string[]; waitResult?: unknown; waitError?: unknown } = {}) {
  const sent = options.sent ?? [];
  const waits: WaitControl = {
    wait: async () => {
      if (options.waitError !== undefined) throw options.waitError;
      return options.waitResult ?? complete;
    },
  };
  const op = (name: string) => async (_opts?: unknown) => {
    sent.push(name);
    return broadcast();
  };
  class EvmClient {
    async createSmartAccount() {
      return fakeSmartAccount(sent, waits);
    }
    async getSmartAccount() {
      return fakeSmartAccount(sent, waits);
    }
    async getOrCreateSmartAccount() {
      return fakeSmartAccount(sent, waits);
    }
    async updateSmartAccount() {
      return fakeSmartAccount(sent, waits);
    }
    async listSmartAccounts() {
      return { accounts: [{ address: SMART, owners: [OWNER], type: 'evm-smart' }] };
    }
    sendUserOperation = op('evm sendUserOperation');
    prepareAndSendUserOperation = op('evm prepareAndSendUserOperation');
    async createSpendPermission() {
      sent.push('createSpendPermission');
      return { network: 'base', userOpHash: OP_HASH, status: 'broadcast', calls: [] };
    }
    async revokeSpendPermission() {
      sent.push('revokeSpendPermission');
      return { network: 'base', userOpHash: OP_HASH, status: 'broadcast', calls: [] };
    }
    waitForUserOperation(opts: unknown) {
      return waits.wait(opts);
    }
    async createSwapQuote(opts: { network: string }) {
      return fakeQuote(opts.network, sent);
    }
  }
  return { cdp: { evm: new EvmClient() as unknown as FakeEvm }, sent, waits };
}

/** A raw `UserOperationEvent` log, as a node returns it in a receipt. */
function userOperationLog(fields: {
  userOpHash?: Hex;
  sender?: Hex;
  paymaster?: Hex;
  success?: boolean;
  address?: string;
}) {
  const topics = encodeEventTopics({
    abi: EVENT_ABI,
    eventName: 'UserOperationEvent',
    args: {
      userOpHash: fields.userOpHash ?? OP_HASH,
      sender: fields.sender ?? SMART,
      paymaster: fields.paymaster ?? PAYMASTER,
    },
  });
  return {
    address: fields.address ?? ENTRY_POINT,
    topics,
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [(5n << 64n) | 3n, fields.success ?? true, 1_234_000n, 90_000n],
    ),
    blockNumber: '0x7b',
    transactionHash: BUNDLE,
    transactionIndex: '0x0',
    blockHash: `0x${'cd'.repeat(32)}`,
    logIndex: '0x0',
    removed: false,
  };
}
const EVENT_ABI = [
  {
    type: 'event',
    name: 'UserOperationEvent',
    inputs: [
      { name: 'userOpHash', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'paymaster', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'success', type: 'bool', indexed: false },
      { name: 'actualGasCost', type: 'uint256', indexed: false },
      { name: 'actualGasUsed', type: 'uint256', indexed: false },
    ],
  },
] as const;

const readerWith = (logs: unknown[], extra: Parameters<typeof mockTransport>[0] = {}) => {
  const mock = mockTransport({ receipt: { transactionHash: BUNDLE, logs }, ...extra });
  return {
    reader: createPublicClient({ chain: base, transport: mock.transport, pollingInterval: 10 }),
    calls: mock.calls,
  };
};

const sends = () => tracing.spans().filter((s) => s.name.startsWith('send '));
const confirms = () => tracing.spans().filter((s) => s.name.startsWith('confirm '));

async function smartAccountOf(
  cdp: { evm: FakeEvm },
  factory: keyof FakeEvm = 'createSmartAccount',
) {
  return (await cdp.evm[factory]()) as SmartAccount;
}

describe('smart accounts from the factories', () => {
  it.each([
    'createSmartAccount',
    'getSmartAccount',
    'getOrCreateSmartAccount',
    'updateSmartAccount',
  ] as const)('trace sendUserOperation of accounts from %s', async (factory) => {
    const { cdp, sent } = fakeCdp();
    withHashspan(cdp);
    const account = await smartAccountOf(cdp, factory);
    await expect(
      account.sendUserOperation({ network: 'base', calls: [{ to: TO }, { to: TO, value: 1n }] }),
    ).resolves.toEqual(broadcast());
    expect(sent).toEqual(['sendUserOperation']);

    const send = tracing.spanNamed('send 8453');
    expect(send.attributes).toMatchObject({
      'blockchain.operation.name': 'send',
      'blockchain.user_operation.hash': OP_HASH,
      'blockchain.user_operation.sender': SMART,
      'blockchain.user_operation.call_count': 2,
    });
    expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
  });

  it('leave listSmartAccounts alone, which returns records without methods', async () => {
    const { cdp } = fakeCdp();
    const listed = { accounts: [{ address: SMART }] };
    cdp.evm.listSmartAccounts = async () => listed;
    withHashspan(cdp);
    await expect(cdp.evm.listSmartAccounts()).resolves.toBe(listed);
    expect(Object.getOwnPropertyNames(listed.accounts[0])).toEqual(['address']);
  });

  it('wrap an account once when a factory returns it again', async () => {
    const { cdp, sent } = fakeCdp();
    const account = fakeSmartAccount(sent, { wait: async () => complete });
    cdp.evm.getSmartAccount = async () => account;
    withHashspan(cdp);
    await cdp.evm.getSmartAccount();
    const again = (await cdp.evm.getSmartAccount()) as SmartAccount;
    await again.sendUserOperation({ network: 'base', calls: [] });
    expect(sends()).toHaveLength(1);
  });

  it('runs the call in the send span, so the CDP API request nests under it', async () => {
    const { cdp } = fakeCdp();
    const active: (string | undefined)[] = [];
    const account = fakeSmartAccount([], { wait: async () => complete });
    account.sendUserOperation = async () => {
      active.push(trace.getActiveSpan()?.spanContext().spanId);
      return broadcast();
    };
    cdp.evm.createSmartAccount = async () => account;
    withHashspan(cdp);
    const traced = await smartAccountOf(cdp);
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    await context.with(trace.setSpan(context.active(), tool), () =>
      traced.sendUserOperation({ network: 'base', calls: [] }),
    );
    tool.end();
    const send = tracing.spanNamed('send 8453');
    expect(active).toEqual([send.spanContext().spanId]);
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  });
});

describe('every method that sends a user operation', () => {
  /** Runs `call` on a traced client and returns the one send span it recorded, with what the SDK was asked. */
  const oneSend = async (
    call: (cdp: { evm: FakeEvm }, account: SmartAccount) => Promise<unknown>,
  ) => {
    const { cdp, sent } = fakeCdp();
    withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await call(cdp, account);
    expect(sends()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    return sends()[0]?.attributes ?? {};
  };

  it.each([
    [
      'account transfer',
      (_: unknown, a: SmartAccount) =>
        a.transfer({ network: 'base', to: TO, amount: 1n, token: 'eth' }),
    ],
    [
      'account useSpendPermission',
      (_: unknown, a: SmartAccount) => a.useSpendPermission({ network: 'base', value: 1n }),
    ],
    ['account swap', (_: unknown, a: SmartAccount) => a.swap({ network: 'base' })],
    [
      'account swap of a quote',
      (_: unknown, a: SmartAccount) => a.swap({ swapQuote: { network: 'base' } }),
    ],
    [
      'execute() of an account quote',
      async (_: unknown, a: SmartAccount) => {
        const quote = (await a.quoteSwap({ network: 'base' })) as { execute: Method };
        return quote.execute();
      },
    ],
    [
      'execute() of a cdp.evm quote for a smart account',
      async (cdp: { evm: FakeEvm }, a: SmartAccount) => {
        const quote = (await cdp.evm.createSwapQuote({ network: 'base', smartAccount: a })) as {
          execute: Method;
        };
        return quote.execute();
      },
    ],
    [
      'cdp.evm.sendUserOperation',
      (cdp: { evm: FakeEvm }, a: SmartAccount) =>
        cdp.evm.sendUserOperation({ smartAccount: a, network: 'base', calls: [{ to: TO }] }),
    ],
    [
      'cdp.evm.prepareAndSendUserOperation',
      (cdp: { evm: FakeEvm }, a: SmartAccount) =>
        cdp.evm.prepareAndSendUserOperation({
          smartAccount: a,
          network: 'base',
          calls: [{ to: TO }],
        }),
    ],
    [
      'cdp.evm.createSpendPermission',
      (cdp: { evm: FakeEvm }) =>
        cdp.evm.createSpendPermission({ network: 'base', spendPermission: { account: SMART } }),
    ],
    [
      'cdp.evm.revokeSpendPermission',
      (cdp: { evm: FakeEvm }) =>
        cdp.evm.revokeSpendPermission({ network: 'base', address: SMART, permissionHash: OP_HASH }),
    ],
  ] as const)('%s records one send span from the smart account', async (_name, call) => {
    const attributes = await oneSend(call as never);
    expect(attributes).toMatchObject({
      'blockchain.chain.id': 8453,
      'blockchain.user_operation.hash': OP_HASH,
      'blockchain.user_operation.sender': SMART,
    });
  });

  it('records the call count only for calls given as an array', async () => {
    const attributes = await oneSend((cdp, a) =>
      cdp.evm.sendUserOperation({ smartAccount: a, network: 'base', calls: { length: 2 } }),
    );
    expect(attributes['blockchain.user_operation.call_count']).toBeUndefined();
  });

  it("records a failure with the CDP API's error type and rethrows the error", async () => {
    const { cdp } = fakeCdp();
    const failure = Object.assign(new Error('rejected'), {
      name: 'APIError',
      errorType: 'invalid_request',
    });
    cdp.evm.sendUserOperation = async () => {
      throw failure;
    };
    withHashspan(cdp);
    await expect(cdp.evm.sendUserOperation({ network: 'base', calls: [] })).rejects.toBe(failure);
    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe('invalid_request');
    expect(send.events[0]?.attributes?.['exception.type']).toBe('APIError');
  });

  it('fails the send span when the result has no userOpHash, and returns the result', async () => {
    const { cdp } = fakeCdp();
    cdp.evm.sendUserOperation = async () => ({ status: 'broadcast' });
    withHashspan(cdp);
    await expect(cdp.evm.sendUserOperation({ network: 'base' })).resolves.toEqual({
      status: 'broadcast',
    });
    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('passes calls on unknown networks or without options through untraced', async () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { cdp, sent } = fakeCdp();
    withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'moonbase', calls: [] });
    await account.sendUserOperation();
    await cdp.evm.sendUserOperation({ network: 'https://rpc.example.invalid/key' });
    expect(sent).toHaveLength(3);
    expect(tracing.spans()).toHaveLength(0);
  });

  it('leaves a cdp.evm quote for a smart account given through a getter untraced', async () => {
    const { cdp, sent } = fakeCdp();
    withHashspan(cdp);
    let reads = 0;
    const options = Object.defineProperty({ network: 'base' }, 'smartAccount', {
      enumerable: true,
      get: () => {
        reads++;
        return { address: SMART };
      },
    });
    const quote = (await cdp.evm.createSwapQuote(options)) as { execute: Method };
    await quote.execute();
    expect(reads).toBe(0);
    expect(sent).toEqual(['quote']);
    expect(tracing.spans()).toHaveLength(0);
  });
});

describe('network-scoped smart accounts', () => {
  const scopedOf = async (network = 'base') => {
    const { cdp, sent } = fakeCdp();
    const hashspan = withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    const scoped = (await account.useNetwork(network)) as unknown as ScopedSmartAccount;
    return { scoped, sent, hashspan };
  };

  it.each([
    ['sendUserOperation', (s: ScopedSmartAccount) => s.sendUserOperation({ calls: [{ to: TO }] })],
    ['transfer', (s: ScopedSmartAccount) => s.transfer({ to: TO, amount: 1n, token: 'eth' })],
    ['swap', (s: ScopedSmartAccount) => s.swap({ fromToken: TO })],
    [
      'quote execute()',
      async (s: ScopedSmartAccount) => ((await s.quoteSwap({})) as { execute: Method }).execute(),
    ],
    // It calls the smart account's own method, which traces it.
    ['useSpendPermission', (s: ScopedSmartAccount) => s.useSpendPermission({ value: 1n })],
  ] as const)('trace %s once, on the scoped network', async (_name, call) => {
    const { scoped, sent } = await scopedOf('polygon');
    await call(scoped);
    expect(sent).toHaveLength(1);
    expect(sends().map((s) => s.name)).toEqual(['send 137']);
    expect(sends()[0]?.attributes['blockchain.user_operation.sender']).toBe(SMART);
  });

  it('take the network of a quote-based swap from the quote', async () => {
    const { scoped } = await scopedOf('polygon');
    await scoped.swap({ swapQuote: { network: 'base' } });
    expect(sends().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('confirm a wait on the scoped network, for an operation sent elsewhere too', async () => {
    const { scoped, hashspan } = await scopedOf('polygon');
    await scoped.waitForUserOperation({ userOpHash: OP_HASH });
    await hashspan.flush();
    expect(confirms().map((s) => s.name)).toEqual(['confirm 137']);
  });

  it('are left alone on unknown networks', async () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const { scoped, sent } = await scopedOf('moonbase');
    await scoped.sendUserOperation({ calls: [] });
    await scoped.waitForUserOperation({ userOpHash: OP_HASH });
    expect(sent).toHaveLength(1);
    expect(tracing.spans()).toHaveLength(0);
  });
});

describe('waitForUserOperation without a reader', () => {
  const sendAndWait = async (waitOptions: Parameters<typeof fakeCdp>[0] = {}) => {
    const { cdp } = fakeCdp(waitOptions);
    const hashspan = withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [{ to: TO }] });
    const wait = account.waitForUserOperation({ userOpHash: OP_HASH });
    return { wait, hashspan, cdp };
  };

  it('ends the confirm span with the bundle hash on complete, without a success flag', async () => {
    const { wait, hashspan } = await sendAndWait();
    await expect(wait).resolves.toEqual(complete);
    await hashspan.flush();
    const send = tracing.spanNamed('send 8453');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': OP_HASH,
      'blockchain.tx.hash': BUNDLE,
    });
    expect(confirm.attributes['blockchain.user_operation.success']).toBeUndefined();
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
    // Without a success flag the outcome is unknown: `_OTHER` (#366).
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['error.type']).toBe('_OTHER');
  });

  it('ends as an error on failed, without an exception event', async () => {
    const { wait, hashspan } = await sendAndWait({ waitResult: failed });
    await expect(wait).resolves.toEqual(failed);
    await hashspan.flush();
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['error.type']).toBe('failed');
    expect(confirm.events).toHaveLength(0);
  });

  it("ends as a timeout on the SDK's TimeoutError, and rethrows it", async () => {
    const timeout = Object.assign(new Error('not terminal'), { name: 'TimeoutError' });
    const { wait, hashspan } = await sendAndWait({ waitError: timeout });
    await expect(wait).rejects.toBe(timeout);
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').attributes['error.type']).toBe('timeout');
  });

  it('ends as a failure on another error, and rethrows it', async () => {
    const failure = new TypeError('network down');
    const { wait, hashspan } = await sendAndWait({ waitError: failure });
    await expect(wait).rejects.toBe(failure);
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').attributes['error.type']).toBe('TypeError');
  });

  it('fails on a result that is not complete, even with a transaction hash', async () => {
    const pending = { status: 'broadcast', transactionHash: BUNDLE, userOpHash: OP_HASH };
    const { wait, hashspan } = await sendAndWait({ waitResult: pending });
    await expect(wait).resolves.toBe(pending);
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('starts no confirm span for a wait without a hash on a scoped account', async () => {
    const tracker = createTxTracker();
    const start = vi.spyOn(tracker, 'startUserOperationConfirm');
    const { cdp } = fakeCdp();
    withHashspan(cdp, { tracker });
    const account = await smartAccountOf(cdp);
    const scoped = (await account.useNetwork('base')) as unknown as ScopedSmartAccount;
    await scoped.waitForUserOperation({ userOpHash: 7 });
    expect(start).not.toHaveBeenCalled();
  });

  it('fails on a result it does not know, and returns it', async () => {
    const odd = { status: 'dropped', userOpHash: OP_HASH };
    const { wait, hashspan } = await sendAndWait({ waitResult: odd });
    await expect(wait).resolves.toBe(odd);
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('confirms through cdp.evm.waitForUserOperation, sharing one span with the account wait', async () => {
    const { wait, hashspan, cdp } = await sendAndWait();
    await Promise.all([
      wait,
      cdp.evm.waitForUserOperation({ userOpHash: OP_HASH, smartAccountAddress: SMART }),
    ]);
    await hashspan.flush();
    expect(confirms()).toHaveLength(1);
  });

  it('passes a wait for an operation sent elsewhere, or without a hash, through untraced', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { cdp } = fakeCdp();
    const hashspan = withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await expect(account.waitForUserOperation({ userOpHash: OTHER_OP_HASH })).resolves.toBe(
      complete,
    );
    await cdp.evm.waitForUserOperation({ userOpHash: OTHER_OP_HASH, smartAccountAddress: SMART });
    await account.waitForUserOperation({});
    await hashspan.flush();
    expect(tracing.spans()).toHaveLength(0);
  });

  it('records the failed outcome as error.type on the confirmation metric', async () => {
    const recorded: { name: string; attributes: Attributes }[] = [];
    const meterProvider = {
      getMeter: () => ({
        createHistogram: (name: string): Histogram =>
          ({
            record: (_value: number, attributes: Attributes = {}) =>
              recorded.push({ name, attributes }),
          }) as Histogram,
      }),
    } as unknown as MeterProvider;
    const { cdp } = fakeCdp({ waitResult: failed });
    const hashspan = withHashspan(cdp, { meterProvider });
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [] });
    await account.waitForUserOperation({ userOpHash: OP_HASH });
    await hashspan.flush();
    const confirmation = recorded.filter(
      (r) => r.name === METRIC_BLOCKCHAIN_CLIENT_CONFIRMATION_DURATION,
    );
    expect(confirmation.map((r) => r.attributes)).toEqual([
      expect.objectContaining({
        'error.type': 'failed',
        'blockchain.operation.subject': 'user_operation',
      }),
    ]);
  });
});

describe('waitForUserOperation with a reader', () => {
  const run = async (
    logs: unknown[],
    extra: Parameters<typeof mockTransport>[0] = {},
    confirmTimeoutMs?: number,
  ) => {
    const { cdp } = fakeCdp();
    const { reader, calls } = readerWith(logs, extra);
    const hashspan = withHashspan(cdp, { reader, confirmTimeoutMs });
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [{ to: TO }] });
    await expect(account.waitForUserOperation({ userOpHash: OP_HASH })).resolves.toEqual(complete);
    return {
      hashspan,
      calls,
      confirm: async () => {
        await hashspan.flush();
        return tracing.spanNamed('confirm 8453');
      },
    };
  };

  it("completes the span from the bundle's UserOperationEvent", async () => {
    const { confirm } = await run([userOperationLog({})]);
    const span = await confirm();
    expect(span.attributes).toMatchObject({
      'blockchain.tx.hash': BUNDLE,
      'blockchain.block.number': 123,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.cost': '1234000',
      'blockchain.user_operation.gas.used': 90_000,
      'blockchain.user_operation.nonce': ((5n << 64n) | 3n).toString(),
      'blockchain.user_operation.sender': SMART,
      'blockchain.user_operation.paymaster': PAYMASTER,
      'blockchain.user_operation.entry_point': ENTRY_POINT.toLowerCase(),
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    // The bundle's fee covers every operation in it: it is not recorded.
    expect(span.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(span.attributes['blockchain.tx.status']).toBeUndefined();
  });

  it('ends as reverted when the operation did not succeed', async () => {
    const span = await (
      await run([userOperationLog({ success: false, paymaster: ZERO })])
    ).confirm();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('reverted');
    expect(span.attributes['blockchain.user_operation.success']).toBe(false);
    expect(span.attributes['blockchain.user_operation.paymaster']).toBeUndefined();
  });

  it("ignores events of other operations and other senders, and uses the last of the operation's", async () => {
    const span = await (
      await run([
        userOperationLog({ success: false, address: TO }),
        userOperationLog({ success: true }),
        userOperationLog({ userOpHash: OTHER_OP_HASH, success: false }),
        userOperationLog({ sender: OTHER_SMART, success: false }),
      ])
    ).confirm();
    expect(span.attributes['blockchain.user_operation.success']).toBe(true);
    expect(span.attributes['blockchain.user_operation.entry_point']).toBe(
      ENTRY_POINT.toLowerCase(),
    );
  });

  it('records only the bundle hash and block without a matching event', async () => {
    const span = await (
      await run([
        { address: TO, topics: [OP_HASH, OP_HASH], data: '0x' },
        userOperationLog({ userOpHash: OTHER_OP_HASH }),
      ])
    ).confirm();
    expect(span.attributes).toMatchObject({
      'blockchain.tx.hash': BUNDLE,
      'blockchain.block.number': 123,
    });
    expect(span.attributes['blockchain.user_operation.success']).toBeUndefined();
  });

  it('polls a reader that has not seen the bundle yet, and ends the span when the wait ended', async () => {
    let mined = false;
    const { calls, confirm } = await run([userOperationLog({})], { mined: () => mined });
    const waited = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60));
    mined = true;
    const flushing = Date.now();
    const span = await confirm();
    // Polled at the reader's own interval (10 ms here).
    expect(Date.now() - flushing).toBeLessThan(500);
    expect(span.attributes['blockchain.user_operation.success']).toBe(true);
    expect(calls.filter((m) => m === 'eth_getTransactionReceipt').length).toBeGreaterThan(1);
    const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
    expect(endMs).toBeLessThan(waited + 30);
  });

  it('gives up after confirmTimeoutMs with what CDP reported', async () => {
    const { confirm } = await run([], { receipt: null }, 50);
    const span = await confirm();
    expect(span.attributes['blockchain.tx.hash']).toBe(BUNDLE);
    expect(span.attributes['error.type']).toBe('_OTHER');
  });

  it('keeps polling through reader errors', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    let failing = true;
    const { cdp } = fakeCdp();
    const { reader } = readerWith([userOperationLog({})]);
    const request = reader.request;
    const flaky = Object.assign(Object.create(reader), {
      pollingInterval: 10,
      request: (args: never) => {
        if (failing) {
          failing = false;
          return Promise.reject(new Error('rpc down'));
        }
        return request(args);
      },
    });
    const hashspan = withHashspan(cdp, { reader: flaky });
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [] });
    await account.waitForUserOperation({ userOpHash: OP_HASH });
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.user_operation.success']).toBe(
      true,
    );
  });

  /** A reader whose `eth_getTransactionReceipt` answers after `delayMs`, or never without one. */
  const slowReader = (delayMs?: number) => {
    const { reader, calls } = readerWith([userOperationLog({})]);
    const request = reader.request;
    const slow = Object.assign(Object.create(reader), {
      pollingInterval: 10,
      request: (args: { method: string }) => {
        calls.push(args.method);
        if (args.method !== 'eth_getTransactionReceipt') return request(args as never);
        if (delayMs === undefined) return new Promise(() => {});
        return new Promise((resolve) => setTimeout(resolve, delayMs)).then(() =>
          request(args as never),
        );
      },
    });
    return { reader: slow, calls };
  };
  const runWith = async (reader: unknown, confirmTimeoutMs?: number) => {
    const { cdp } = fakeCdp();
    const hashspan = withHashspan(cdp, { reader: reader as never, confirmTimeoutMs });
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [{ to: TO }] });
    await expect(account.waitForUserOperation({ userOpHash: OP_HASH })).resolves.toEqual(complete);
    return hashspan;
  };

  it('gives up after confirmTimeoutMs on a reader whose request never answers', async () => {
    const { reader } = slowReader();
    const hashspan = await runWith(reader, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The span ended at the deadline, with what CDP reported, and the tracked work settled.
    const span = tracing.spanNamed('confirm 8453');
    expect(span.attributes['blockchain.tx.hash']).toBe(BUNDLE);
    expect(span.attributes['error.type']).toBe('_OTHER');
    expect(span.attributes['blockchain.user_operation.success']).toBeUndefined();
    await expect(hashspan.flush({ timeoutMs: 10 })).resolves.toBe(true);
    await expect(hashspan.flush({ timeoutMs: 10 })).resolves.toBe(true);
    expect(tracing.spans().filter((s) => s.name === 'confirm 8453')).toHaveLength(1);
  });

  it('accepts no bundle receipt that arrives after confirmTimeoutMs', async () => {
    const { reader } = slowReader(80);
    const hashspan = await runWith(reader, 20);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(hashspan.flush({ timeoutMs: 100 })).resolves.toBe(true);

    const span = tracing.spanNamed('confirm 8453');
    expect(span.attributes['blockchain.tx.hash']).toBe(BUNDLE);
    expect(span.attributes['blockchain.user_operation.success']).toBeUndefined();
  });

  it('settles its work when flush() gives up on a request that never answers', async () => {
    const { reader } = slowReader();
    const hashspan = await runWith(reader);

    await expect(hashspan.flush({ timeoutMs: 30 })).resolves.toBe(false);
    const span = tracing.spanNamed('confirm 8453');
    expect(span.attributes['blockchain.tx.hash']).toBe(BUNDLE);
    expect(span.attributes['error.type']).toBe('_OTHER');
    // The request cannot be cancelled, but the work flush() awaits no longer waits for it.
    await expect(hashspan.flush({ timeoutMs: 30 })).resolves.toBe(true);
  });

  it('ends a completed operation with what is known when flush() gives up', async () => {
    const { hashspan, calls } = await run([], { receipt: null });
    await expect(hashspan.flush({ timeoutMs: 30 })).resolves.toBe(false);
    const span = tracing.spanNamed('confirm 8453');
    expect(span.attributes['blockchain.tx.hash']).toBe(BUNDLE);
    expect(span.attributes['error.type']).toBe('_OTHER');
    // It also stops polling the reader.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const polled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.length).toBe(polled);
  });

  it("matches the event to cdp.evm.waitForUserOperation's smartAccountAddress", async () => {
    const { cdp } = fakeCdp();
    // A send whose sender the adapter cannot tell.
    cdp.evm.sendUserOperation = async () => ({ status: 'broadcast', userOpHash: OP_HASH });
    const { reader } = readerWith([
      userOperationLog({ success: true }),
      userOperationLog({ sender: OTHER_SMART, success: false }),
    ]);
    const hashspan = withHashspan(cdp, { reader });
    await cdp.evm.sendUserOperation({ network: 'base', calls: [] });
    await cdp.evm.waitForUserOperation({ userOpHash: OP_HASH, smartAccountAddress: SMART });
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.user_operation.success']).toBe(
      true,
    );
  });

  it('records no transaction confirm span for the bundle with a reader extended by @hashspan/viem', async () => {
    const tracker = createTxTracker();
    const hashspanViem = withViemHashspan({ tracker });
    const { cdp } = fakeCdp();
    const { reader } = readerWith([userOperationLog({})]);
    const hashspanCdp = withHashspan(cdp, { tracker, reader: reader.extend(hashspanViem) });
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [] });
    await account.waitForUserOperation({ userOpHash: OP_HASH });
    await Promise.all([hashspanCdp.flush(), hashspanViem.flush()]);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['blockchain.user_operation.hash']).toBe(OP_HASH);
  });
});

describe('flush() and user operation waits', () => {
  it('ends a wait still running as a timeout when it gives up', async () => {
    const { cdp, waits } = fakeCdp();
    let resolve: (value: unknown) => void = () => {};
    waits.wait = () =>
      new Promise((r) => {
        resolve = r;
      });
    const hashspan = withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [] });
    const wait = account.waitForUserOperation({ userOpHash: OP_HASH });
    await expect(hashspan.flush({ timeoutMs: 20 })).resolves.toBe(false);
    expect(tracing.spanNamed('confirm 8453').attributes['error.type']).toBe('timeout');
    resolve(complete);
    await expect(wait).resolves.toBe(complete);
    await hashspan.flush();
    expect(confirms()).toHaveLength(1);
  });
});

describe('trackers without user operations', () => {
  it('pass every call through untraced, with one warning', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const real = createTxTracker();
    const { startUserOperationSend: _s, startUserOperationConfirm: _c, ...old } = real;
    const { cdp, sent } = fakeCdp();
    const hashspan = withHashspan(cdp, { tracker: old as typeof real });
    const account = await smartAccountOf(cdp);
    await expect(account.sendUserOperation({ network: 'base', calls: [] })).resolves.toEqual(
      broadcast(),
    );
    await account.transfer({ network: 'base' });
    await expect(account.waitForUserOperation({ userOpHash: OP_HASH })).resolves.toBe(complete);
    await hashspan.flush();
    const scoped = (await account.useNetwork('base')) as unknown as ScopedSmartAccount;
    const error = vi.spyOn(diag, 'error').mockImplementation(() => {});
    await expect(scoped.waitForUserOperation({ userOpHash: OP_HASH })).resolves.toBe(complete);
    await hashspan.flush();
    expect(sent).toHaveLength(2);
    expect(tracing.spans()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('records nothing when the tracker throws, and never changes the result', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker();
    tracker.startUserOperationSend = () => {
      throw new Error('broken');
    };
    tracker.startUserOperationConfirm = () => {
      throw new Error('broken');
    };
    const { cdp } = fakeCdp();
    withHashspan(cdp, { tracker });
    const account = await smartAccountOf(cdp);
    await expect(account.sendUserOperation({ network: 'base', calls: [] })).resolves.toEqual(
      broadcast(),
    );
    await expect(account.waitForUserOperation({ userOpHash: OP_HASH })).resolves.toBe(complete);
  });
});

describe('arguments and results that telemetry must not touch', () => {
  const trapped = () =>
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );

  it.each([
    'sendUserOperation',
    'transfer',
    'swap',
    'useSpendPermission',
    'waitForUserOperation',
  ] as const)('%s with options that throw on read calls the SDK once, untraced', async (method) => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const { cdp, sent, waits } = fakeCdp();
    let waited = 0;
    const wait = waits.wait;
    waits.wait = (opts) => {
      waited++;
      return wait(opts);
    };
    withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await account[method](trapped());
    expect(sent.length + waited).toBe(1);
    expect(tracing.spans()).toHaveLength(0);
  });

  it('leaves the network, calls and hash behind getters to the SDK', async () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { cdp } = fakeCdp();
    const hashspan = withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    let reads = 0;
    const getter = (value: unknown) => ({
      enumerable: true,
      get: () => {
        reads++;
        return value;
      },
    });
    await account.sendUserOperation(
      Object.defineProperty({ calls: [] }, 'network', getter('base')),
    );
    await account.sendUserOperation(
      Object.defineProperty({ network: 'base' }, 'calls', getter([{ to: TO }])),
    );
    await account.waitForUserOperation(Object.defineProperty({}, 'userOpHash', getter(OP_HASH)));
    await hashspan.flush();
    expect(reads).toBe(0);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.attributes['blockchain.user_operation.call_count']).toBeUndefined();
    expect(confirms()).toHaveLength(0);
  });

  it('a frozen smart account from a factory is returned unchanged and untraced', async () => {
    const { cdp, sent } = fakeCdp();
    const frozen = Object.freeze(fakeSmartAccount(sent, { wait: async () => complete }));
    cdp.evm.getSmartAccount = async () => frozen;
    withHashspan(cdp);
    const account = (await cdp.evm.getSmartAccount()) as SmartAccount;
    expect(account).toBe(frozen);
    await account.sendUserOperation({ network: 'base', calls: [] });
    expect(sends()).toHaveLength(0);
  });

  it('a smart account wrapped part-way is not marked, and wrapping it again traces each call once', async () => {
    const { cdp, sent } = fakeCdp();
    const account = fakeSmartAccount(sent, { wait: async () => complete });
    Object.defineProperty(account, 'swap', { value: account.swap, writable: false });
    cdp.evm.getSmartAccount = async () => account;
    withHashspan(cdp);
    const first = (await cdp.evm.getSmartAccount()) as SmartAccount;
    expect(Symbol.for('hashspan.cdp.wrapped') in first).toBe(false);
    const again = (await cdp.evm.getSmartAccount()) as SmartAccount;
    await again.sendUserOperation({ network: 'base', calls: [] });
    expect(sends()).toHaveLength(1);
  });

  it('smart accounts, scoped accounts and quotes that throw when inspected are returned unchanged', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const { cdp, sent } = fakeCdp();
    const WRAPPED = Symbol.for('hashspan.cdp.wrapped');
    const inspected = new Proxy(fakeSmartAccount(sent, { wait: async () => complete }), {
      get: (target, key) => {
        if (key === WRAPPED) throw new Error('trap');
        return Reflect.get(target, key);
      },
    });
    const scoped = trapped();
    const plain = fakeSmartAccount(sent, { wait: async () => complete });
    plain.useNetwork = async () => scoped;
    cdp.evm.getSmartAccount = async () => inspected;
    cdp.evm.createSmartAccount = async () => plain;
    withHashspan(cdp);
    await expect(cdp.evm.getSmartAccount()).resolves.toBe(inspected);
    const traced = await smartAccountOf(cdp);
    await expect(traced.useNetwork('base')).resolves.toBe(scoped);
    await expect(cdp.evm.createSwapQuote(trapped())).resolves.toMatchObject({
      liquidityAvailable: true,
    });
  });

  it('a result that throws when read still reaches the caller', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const { cdp, waits } = fakeCdp();
    const odd = trapped();
    waits.wait = async () => odd;
    const hashspan = withHashspan(cdp);
    const account = await smartAccountOf(cdp);
    await account.sendUserOperation({ network: 'base', calls: [] });
    await expect(account.waitForUserOperation({ userOpHash: OP_HASH })).resolves.toBe(odd);
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 8453').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('userOperationReceiptFromBundle', () => {
  it('reads the bundle hash and block from any receipt-shaped value', () => {
    expect(
      userOperationReceiptFromBundle(
        { transactionHash: BUNDLE, blockNumber: '0x10' },
        OP_HASH,
        undefined,
      ),
    ).toEqual({
      transactionHash: BUNDLE,
      blockNumber: 16n,
    });
    expect(userOperationReceiptFromBundle(null, OP_HASH, undefined)).toEqual({
      transactionHash: undefined,
      blockNumber: undefined,
    });
  });

  it('checksums the EntryPoint address, and leaves out one that is not an address', () => {
    const lower = userOperationLog({ address: ENTRY_POINT.toLowerCase() });
    expect(userOperationReceiptFromBundle({ logs: [lower] }, OP_HASH, SMART).entryPoint).toBe(
      ENTRY_POINT,
    );
    const odd = userOperationLog({ address: 'nowhere' });
    expect(userOperationReceiptFromBundle({ logs: [odd] }, OP_HASH, SMART)).toMatchObject({
      entryPoint: undefined,
      success: true,
    });
  });

  it('matches any sender when the sender is unknown, and the hash in any case', () => {
    const receipt = userOperationReceiptFromBundle(
      { logs: [userOperationLog({ userOpHash: BUNDLE, sender: OTHER_SMART })] },
      BUNDLE.toUpperCase().replace('0X', '0x'),
      undefined,
    );
    expect(receipt.sender?.toLowerCase()).toBe(OTHER_SMART);
  });

  it('remembers a bounded number of sent operations, dropping the oldest', () => {
    const sent = new SentUserOperations(2);
    sent.add(OP_HASH, 1, SMART);
    sent.add(OTHER_OP_HASH, 2, undefined);
    sent.add(OP_HASH, 3, SMART);
    sent.add(BUNDLE, 4, undefined);
    expect(sent.get(OTHER_OP_HASH)).toBeUndefined();
    expect(sent.get(OP_HASH)).toEqual({ chainId: 3, sender: SMART });
    expect(sent.get(BUNDLE.toUpperCase().replace('0X', '0x'))).toEqual({
      chainId: 4,
      sender: undefined,
    });
  });
});
