// watchUserOperation(): a user operation sent elsewhere, confirmed from its hash through a bundler client or from its
// bundle transaction's receipt (docs/adr/0031-watch-user-operation.md).
import { createTxTracker } from '@hashspan/core';
import { context, diag, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, custom, getAddress, RpcRequestError } from 'viem';
import { createBundlerClient, entryPoint07Address } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { recordingMeterProvider } from './fault-checks.js';
import {
  BUNDLE_HASH,
  type MockBundlerOptions,
  mockBundler,
  NONCE,
  PAYMASTER,
  SENDER,
  stubAccount,
  USER_OP_HASH,
  userOperationEventLog,
} from './mock-bundler.js';
import { HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const CHAIN_ID = baseSepolia.id;
const OTHER_OP_HASH = `0x${'a2'.repeat(32)}` as const;
const confirms = () => tracing.spans().filter((s) => s.name === `confirm ${CHAIN_ID}`);

interface NodeOptions {
  /** The bundle receipt per `eth_getTransactionReceipt` call (the first is 1); `null` means "not mined yet". */
  receiptAt?: (call: number) => Record<string, unknown> | null;
  /** Fails the `eth_getTransactionReceipt` calls this returns true for. */
  failAt?: (call: number) => boolean;
  chainIdHex?: string;
}

/** A node on Base Sepolia whose bundle transaction carries `logs`. */
function node(logs: unknown[] = [userOperationEventLog()], options: NodeOptions = {}) {
  const methods: string[] = [];
  let receiptCalls = 0;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      methods.push(method);
      if (method === 'eth_chainId') return options.chainIdHex ?? '0x14a34';
      if (method === 'eth_getTransactionReceipt') {
        const call = ++receiptCalls;
        if (options.failAt?.(call)) {
          throw new RpcRequestError({
            body: { params },
            error: { code: -32603, message: 'internal error' },
            url: 'mock',
          });
        }
        const given = options.receiptAt ? options.receiptAt(call) : {};
        if (given === null) return null;
        return {
          transactionHash: BUNDLE_HASH,
          blockHash: `0x${'cd'.repeat(32)}`,
          blockNumber: '0x2a',
          from: '0x4444444444444444444444444444444444444444',
          to: entryPoint07Address.toLowerCase(),
          status: '0x1',
          gasUsed: '0x30000',
          effectiveGasPrice: '0x3b9aca00',
          logs,
          ...given,
        };
      }
      throw new Error(`mock node: unexpected method ${method}`);
    },
  });
  return { transport, methods };
}

async function bundlerClient(options: MockBundlerOptions = {}) {
  const bundler = mockBundler(options);
  const client = createBundlerClient({
    account: await stubAccount(bundler.transport),
    chain: baseSepolia,
    transport: bundler.transport,
    pollingInterval: 10,
  });
  return { client, bundler };
}

const reader = (transport: ReturnType<typeof node>['transport'], chain = true) =>
  createPublicClient({ ...(chain ? { chain: baseSepolia } : {}), transport, pollingInterval: 10 });

describe('watchUserOperation in a bundle', () => {
  it('records the operation of the sender, not the bundle transaction', async () => {
    const meters = recordingMeterProvider();
    const hashspan = withHashspan({ meterProvider: meters.provider });
    const { transport, methods } = node([
      userOperationEventLog({ sender: '0x6666666666666666666666666666666666666666' }),
      userOperationEventLog({ userOpHash: OTHER_OP_HASH, paymaster: PAYMASTER }),
    ]);
    // A client extended by the same hashspan: its wrapped actions are not used.
    const client = reader(transport).extend(hashspan);

    expect(
      hashspan.watchUserOperation(client, { bundleHash: BUNDLE_HASH, sender: SENDER }),
    ).toBeUndefined();
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(tracing.spans()).toHaveLength(1);
    const [confirm] = confirms();
    expect(confirm?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm?.attributes).toEqual({
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': OTHER_OP_HASH,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.used': 500,
      'blockchain.user_operation.gas.cost': '1000',
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.nonce': NONCE.toString(),
      'blockchain.user_operation.paymaster': PAYMASTER,
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.tx.hash': BUNDLE_HASH,
      'blockchain.block.number': 42,
    });
    expect(methods).toEqual(['eth_getTransactionReceipt']);
    expect(meters.recorded('blockchain.client.fee')).toEqual([
      {
        value: 1000,
        attributes: expect.objectContaining({ 'blockchain.operation.subject': 'user_operation' }),
      },
    ]);
  });

  it('records a reverted operation in a bundle that succeeded', async () => {
    const hashspan = withHashspan();
    const { transport } = node([userOperationEventLog({ success: false })]);
    hashspan.watchUserOperation(reader(transport), { bundleHash: BUNDLE_HASH, sender: SENDER });
    await hashspan.flush();
    const [confirm] = confirms();
    expect(confirm?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm?.attributes).toMatchObject({
      'blockchain.user_operation.success': false,
      'error.type': 'reverted',
    });
    expect(confirm?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirm?.attributes['blockchain.tx.fee']).toBeUndefined();
  });

  it('links to the send span of the same tracker, under the span active at the call, from the call', async () => {
    const tracker = createTxTracker();
    const send = tracker.startUserOperationSend({ chainId: CHAIN_ID });
    send.end({ userOpHash: USER_OP_HASH });
    const hashspan = withHashspan({ tracker });
    // Not mined at the first poll.
    const { transport } = node(undefined, { receiptAt: (call) => (call === 1 ? null : {}) });
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    const before = Date.now();
    context.with(trace.setSpan(context.active(), tool), () =>
      hashspan.watchUserOperation(reader(transport), { bundleHash: BUNDLE_HASH, sender: SENDER }),
    );
    await hashspan.flush();
    tool.end();

    const sendSpan = tracing.spanNamed(`send ${CHAIN_ID}`);
    const [confirm] = confirms();
    expect(confirm?.links.map((link) => link.context.spanId)).toEqual([
      sendSpan.spanContext().spanId,
    ]);
    expect(confirm?.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    const startMs = (confirm?.startTime[0] ?? 0) * 1000 + (confirm?.startTime[1] ?? 0) / 1e6;
    expect(startMs).toBeLessThanOrEqual(before + 5);
  });

  it('polls again after a failed request and a missing receipt', async () => {
    const hashspan = withHashspan();
    const { transport, methods } = node(undefined, {
      failAt: (call) => call === 1,
      receiptAt: (call) => (call === 2 ? null : {}),
    });
    hashspan.watchUserOperation(reader(transport), { bundleHash: BUNDLE_HASH, sender: SENDER });
    await hashspan.flush();
    expect(methods).toEqual([
      'eth_getTransactionReceipt',
      'eth_getTransactionReceipt',
      'eth_getTransactionReceipt',
    ]);
    expect(confirms()).toHaveLength(1);
  });

  it('records nothing when the receipt does not come in time', async () => {
    const hashspan = withHashspan();
    const { transport, methods } = node(undefined, { receiptAt: () => null });
    hashspan.watchUserOperation(reader(transport), {
      bundleHash: BUNDLE_HASH,
      sender: SENDER,
      timeoutMs: 50,
    });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spans()).toEqual([]);
    expect(methods.length).toBeGreaterThan(1);
  });

  const nothing: Record<string, { logs?: unknown[]; options?: NodeOptions; warning: string }> = {
    'no event of the sender': {
      logs: [userOperationEventLog({ sender: '0x6666666666666666666666666666666666666666' })],
      warning: 'no UserOperationEvent of the sender in the bundle',
    },
    'a forged event of another contract': {
      logs: [userOperationEventLog({ address: '0x9999999999999999999999999999999999999999' })],
      warning: 'no UserOperationEvent of the sender in the bundle',
    },
    'two operations of the sender': {
      logs: [userOperationEventLog(), userOperationEventLog({ userOpHash: OTHER_OP_HASH })],
      warning: 'several UserOperationEvents of the sender in the bundle; give its nonce',
    },
    'more logs than are read': {
      logs: Array.from({ length: 10_001 }, () => userOperationEventLog()),
      warning: 'the bundle receipt has more logs than are read',
    },
    'the receipt of another transaction': {
      options: { receiptAt: () => ({ transactionHash: `0x${'cc'.repeat(32)}` }) },
      warning: 'the receipt is of another transaction',
    },
  };
  it.each(Object.keys(nothing))('records nothing for %s, with a warning', async (row) => {
    const { logs, options, warning } = nothing[row] as (typeof nothing)[string];
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const hashspan = withHashspan();
    const { transport } = node(logs, options);
    hashspan.watchUserOperation(reader(transport), { bundleHash: BUNDLE_HASH, sender: SENDER });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spans()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `hashspan: watchUserOperation() found ${warning}; not recording it`,
    );
  });

  it('tells several operations of the sender apart by nonce, given in any form', async () => {
    for (const nonce of [
      NONCE + 1n,
      Number(5n),
      (NONCE + 1n).toString(),
      `0x${(NONCE + 1n).toString(16)}`,
    ]) {
      tracing.exporter.reset();
      const hashspan = withHashspan();
      const { transport } = node([
        userOperationEventLog(),
        userOperationEventLog({ userOpHash: OTHER_OP_HASH, nonce: NONCE + 1n }),
        userOperationEventLog({ userOpHash: `0x${'a3'.repeat(32)}`, nonce: 5n }),
      ]);
      hashspan.watchUserOperation(reader(transport), {
        bundleHash: BUNDLE_HASH,
        sender: SENDER,
        nonce,
      });
      await hashspan.flush();
      expect(confirms().map((s) => s.attributes['blockchain.user_operation.hash'])).toEqual([
        nonce === 5 ? `0x${'a3'.repeat(32)}` : OTHER_OP_HASH,
      ]);
    }
  });

  it('matches the userOpHash too when it is given', async () => {
    const hashspan = withHashspan();
    const { transport } = node([
      userOperationEventLog(),
      userOperationEventLog({ userOpHash: OTHER_OP_HASH }),
    ]);
    hashspan.watchUserOperation(reader(transport), {
      bundleHash: BUNDLE_HASH,
      sender: getAddress(SENDER),
      userOpHash: OTHER_OP_HASH,
    });
    await hashspan.flush();
    expect(confirms().map((s) => s.attributes['blockchain.user_operation.hash'])).toEqual([
      OTHER_OP_HASH,
    ]);
  });

  it('asks a client without a chain for its chain id', async () => {
    const hashspan = withHashspan();
    const { transport, methods } = node();
    hashspan.watchUserOperation(reader(transport, false), {
      bundleHash: BUNDLE_HASH,
      sender: SENDER,
    });
    await hashspan.flush();
    expect(methods).toEqual(['eth_chainId', 'eth_getTransactionReceipt']);
    expect(confirms()).toHaveLength(1);
  });

  it('records nothing and sends no request when the chain id contradicts the client', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const hashspan = withHashspan();
    const { transport, methods } = node();
    hashspan.watchUserOperation(reader(transport), {
      bundleHash: BUNDLE_HASH,
      sender: SENDER,
      chainId: 1,
    });
    await hashspan.flush();
    expect(tracing.spans()).toEqual([]);
    expect(methods).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `hashspan: watchUserOperation() got chain 1 and a client on chain ${CHAIN_ID}; not recording it`,
    );
  });

  it('sends no request for invalid input', async () => {
    const hashspan = withHashspan();
    const { transport, methods } = node();
    const client = reader(transport);
    for (const options of [
      {},
      { bundleHash: 'nope', sender: SENDER },
      { bundleHash: BUNDLE_HASH },
      { bundleHash: BUNDLE_HASH, sender: 'nope' },
      { bundleHash: BUNDLE_HASH, sender: SENDER, nonce: -1n },
      { bundleHash: BUNDLE_HASH, sender: SENDER, nonce: 1.5 },
      { bundleHash: BUNDLE_HASH, sender: SENDER, nonce: 'five' },
      { bundleHash: BUNDLE_HASH, sender: SENDER, nonce: `0x${'f'.repeat(65)}` },
      { bundleHash: BUNDLE_HASH, sender: SENDER, userOpHash: 'nope' },
      { bundleHash: BUNDLE_HASH, sender: SENDER, chainId: 0 },
      { userOpHash: 'nope' },
    ]) {
      expect(() => hashspan.watchUserOperation(client, options as never)).not.toThrow();
    }
    await hashspan.flush();
    expect(methods).toEqual([]);
    expect(tracing.spans()).toEqual([]);
  });

  it('is one of the background confirmations', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const hashspan = withHashspan({ maxBackgroundConfirmations: 1 });
    // A watch() that polls takes the one slot.
    const pending = createPublicClient({
      chain: baseSepolia,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    });
    hashspan.watch(pending, { hash: HASH, timeoutMs: 100 });
    const { transport, methods } = node();
    hashspan.watchUserOperation(reader(transport), { bundleHash: BUNDLE_HASH, sender: SENDER });
    await hashspan.flush();
    expect(methods).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxBackgroundConfirmations'));
    // Once it ended, the slot is free again.
    hashspan.watchUserOperation(reader(transport), { bundleHash: BUNDLE_HASH, sender: SENDER });
    await hashspan.flush();
    expect(confirms().filter((s) => s.attributes['blockchain.user_operation.hash'])).toHaveLength(
      1,
    );
  });
});

describe('watchUserOperation by hash', () => {
  it('records the receipt the bundler returns', async () => {
    const hashspan = withHashspan();
    const { client, bundler } = await bundlerClient({ receipt: { paymaster: PAYMASTER } });

    hashspan.watchUserOperation(client, { userOpHash: USER_OP_HASH });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(bundler.calls).toEqual(['eth_getUserOperationReceipt']);
    expect(tracing.spans()).toHaveLength(1);
    expect(confirms()[0]?.attributes).toEqual({
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': USER_OP_HASH,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.used': 0x181cd,
      'blockchain.user_operation.gas.cost': BigInt('0x1cbe991a08').toString(),
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.nonce': NONCE.toString(),
      'blockchain.user_operation.paymaster': PAYMASTER,
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.tx.hash': BUNDLE_HASH,
      'blockchain.block.number': 42,
    });
  });

  it('records the same span as a traced waitForUserOperationReceipt', async () => {
    const run = async (watched: boolean) => {
      tracing.exporter.reset();
      const hashspan = withHashspan();
      const { client } = await bundlerClient({ receipt: { success: false, reason: '0x' } });
      if (watched) hashspan.watchUserOperation(client, { userOpHash: USER_OP_HASH });
      else await client.extend(hashspan).waitForUserOperationReceipt({ hash: USER_OP_HASH });
      await hashspan.flush();
      const [confirm] = confirms();
      return { attributes: confirm?.attributes, status: confirm?.status };
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('ends as timeout when the receipt does not come in time', async () => {
    const hashspan = withHashspan();
    const { client } = await bundlerClient({ receipt: null });
    hashspan.watchUserOperation(client, { userOpHash: USER_OP_HASH, timeoutMs: 50 });
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(confirms()[0]?.attributes['error.type']).toBe('timeout');
  });

  it('polls again after a failed request', async () => {
    let calls = 0;
    const hashspan = withHashspan();
    const bundler = mockBundler();
    const flaky = custom({
      async request(args: { method: string; params?: unknown }) {
        if (args.method === 'eth_getUserOperationReceipt' && ++calls === 1) {
          throw new Error('connection reset');
        }
        return bundler.transport({ chain: baseSepolia }).request(args as never);
      },
    });
    const client = createBundlerClient({
      chain: baseSepolia,
      transport: flaky,
      pollingInterval: 10,
    });
    hashspan.watchUserOperation(client, { userOpHash: USER_OP_HASH });
    await hashspan.flush();
    expect(calls).toBe(2);
    expect(confirms()[0]?.attributes['blockchain.user_operation.success']).toBe(true);
  });

  it('records no data from the receipt of another operation', async () => {
    const hashspan = withHashspan();
    const { client } = await bundlerClient();
    hashspan.watchUserOperation(client, { userOpHash: OTHER_OP_HASH });
    await hashspan.flush();
    const [confirm] = confirms();
    expect(confirm?.attributes).toEqual({
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': OTHER_OP_HASH,
      'error.type': '_OTHER',
    });
  });

  it('records nothing and sends no request on a client without bundler actions', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const hashspan = withHashspan();
    const { transport, methods } = node();
    hashspan.watchUserOperation(reader(transport), { userOpHash: USER_OP_HASH });
    await hashspan.flush();
    expect(methods).toEqual([]);
    expect(tracing.spans()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'hashspan: watchUserOperation() with a userOpHash alone needs a bundler client; not recording it',
    );
  });

  it('takes the chain of the client a bundler client was created with', async () => {
    const hashspan = withHashspan();
    const bundler = mockBundler();
    const client = createBundlerClient({
      client: createPublicClient({ chain: baseSepolia, transport: bundler.transport }),
      transport: bundler.transport,
      pollingInterval: 10,
    });
    hashspan.watchUserOperation(client, { userOpHash: USER_OP_HASH });
    await hashspan.flush();
    expect(bundler.calls).toEqual(['eth_getUserOperationReceipt']);
    expect(confirms()).toHaveLength(1);
  });

  it('ends as timeout and stops polling when a flush gives up', async () => {
    const hashspan = withHashspan();
    const { client, bundler } = await bundlerClient({ receipt: null });
    hashspan.watchUserOperation(client, { userOpHash: USER_OP_HASH });
    await expect(hashspan.flush({ timeoutMs: 30 })).resolves.toBe(false);
    expect(confirms()[0]?.attributes['error.type']).toBe('timeout');
    const polled = bundler.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bundler.calls.length).toBeLessThanOrEqual(polled + 1);
  });
});
