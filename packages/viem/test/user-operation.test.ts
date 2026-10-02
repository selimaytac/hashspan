import { createTxTracker, type TxTracker } from '@hashspan/core';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  createClient,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  parseAbi,
} from 'viem';
import { bundlerActions, createBundlerClient, entryPoint07Address } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  BUNDLE_HASH,
  GAS,
  type MockBundlerOptions,
  mockBundler,
  NONCE,
  PAYMASTER,
  RECIPIENT,
  SENDER,
  stubAccount,
  USER_OP_HASH,
} from './mock-bundler.js';
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
const calls = [
  { to: RECIPIENT, value: 1n },
  { to: RECIPIENT, data: '0xa9059cbb' as const },
];

async function bundlerWith(options: MockBundlerOptions = {}, hashspanOptions = {}) {
  const bundler = mockBundler(options);
  const account = await stubAccount(bundler.transport);
  const hashspan = withHashspan(hashspanOptions);
  const client = createBundlerClient({
    account,
    chain: baseSepolia,
    transport: bundler.transport,
  }).extend(hashspan);
  return { client, hashspan, bundler, account };
}

describe('sendUserOperation', () => {
  it('records a send span with the smart account, EntryPoint, call count and hash', async () => {
    const { client } = await bundlerWith();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const hash = await context.with(trace.setSpan(context.active(), tool), () =>
      client.sendUserOperation({ calls, ...GAS }),
    );
    tool.end();

    expect(hash).toBe(USER_OP_HASH);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'send',
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.entry_point': entryPoint07Address,
      'blockchain.user_operation.call_count': 2,
      'blockchain.user_operation.hash': USER_OP_HASH,
    });
  });

  it('runs the call with the send span active (ADR 0015)', async () => {
    let active: string | undefined;
    const { client } = await bundlerWith({
      onRequest: (method) => {
        if (method === 'eth_sendUserOperation') {
          active = trace.getSpan(context.active())?.spanContext().spanId;
        }
      },
    });
    await client.sendUserOperation({ calls, ...GAS });
    expect(active).toBe(tracing.spanNamed(`send ${CHAIN_ID}`).spanContext().spanId);
  });

  it('records a failed send and rethrows the original error', async () => {
    const { client } = await bundlerWith({
      sendError: { code: -32500, message: 'AA21 didnt pay prefund' },
    });
    const error = await client.sendUserOperation({ calls, ...GAS }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe((error as Error).name);
    expect(send.attributes['blockchain.user_operation.hash']).toBeUndefined();
  });

  it('records the sender of a complete user operation sent without an account', async () => {
    const bundler = mockBundler();
    const client = createBundlerClient({ chain: baseSepolia, transport: bundler.transport }).extend(
      withHashspan(),
    );
    await client.sendUserOperation({
      sender: SENDER,
      nonce: NONCE,
      callData: '0x',
      signature: `0x${'11'.repeat(65)}`,
      entryPointAddress: entryPoint07Address,
      ...GAS,
    });
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).attributes).toMatchObject({
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.entry_point': entryPoint07Address,
    });
    expect(
      tracing.spanNamed(`send ${CHAIN_ID}`).attributes['blockchain.user_operation.call_count'],
    ).toBeUndefined();
  });
});

describe('waitForUserOperationReceipt', () => {
  it('records the operation receipt on a confirm span linked to the send span', async () => {
    const { client } = await bundlerWith();
    const hash = await client.sendUserOperation({ calls, ...GAS });
    const receipt = await client.waitForUserOperationReceipt({ hash });

    // viem types the nonce as a bigint, but passes on the bundler's hex string.
    expect(receipt.nonce).toBe(`0x${NONCE.toString(16)}`);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.links.map((link) => link.context.spanId)).toEqual([send.spanContext().spanId]);
    expect(confirm.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': USER_OP_HASH,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.used': 0x181cd,
      'blockchain.user_operation.gas.cost': (0x1cbe991a08).toString(),
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.nonce': NONCE.toString(),
      'blockchain.user_operation.entry_point': entryPoint07Address,
      'blockchain.tx.hash': BUNDLE_HASH,
      'blockchain.block.number': 42,
    });
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records the paymaster that paid', async () => {
    const { client } = await bundlerWith({ receipt: { paymaster: PAYMASTER } });
    await client.waitForUserOperationReceipt({ hash: USER_OP_HASH });
    expect(
      tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['blockchain.user_operation.paymaster'],
    ).toBe(PAYMASTER);
  });

  it('ends a reverted operation with error.type reverted and the decoded reason', async () => {
    const reason = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['boom'],
    });
    const { client } = await bundlerWith({ receipt: { success: false, reason } });
    const receipt = await client.waitForUserOperationReceipt({ hash: USER_OP_HASH });

    expect(receipt.success).toBe(false);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.user_operation.success': false,
      'error.type': 'reverted',
      'blockchain.tx.revert.reason': 'boom',
      'blockchain.tx.hash': BUNDLE_HASH,
    });
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
  });

  it('records no revert reason for an operation that succeeded', async () => {
    const { client } = await bundlerWith({ receipt: { success: true, reason: '0x08c379a0' } });
    await client.waitForUserOperationReceipt({ hash: USER_OP_HASH });
    expect(
      tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['blockchain.tx.revert.reason'],
    ).toBeUndefined();
  });

  it('records a wait whose base action throws synchronously, and rethrows as a rejection', async () => {
    const failure = new Error('sync');
    const client = createBundlerClient({ chain: baseSepolia, transport: mockBundler().transport })
      .extend(() => ({
        waitForUserOperationReceipt: () => {
          throw failure;
        },
      }))
      .extend(withHashspan());
    await expect(client.waitForUserOperationReceipt({ hash: USER_OP_HASH })).rejects.toBe(failure);
    await vi.waitFor(() => tracing.spanNamed(`confirm ${CHAIN_ID}`));
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['error.type']).toBe('Error');
  });

  it('records no reason that is not revert data', async () => {
    const { client } = await bundlerWith({
      receipt: { success: false, reason: `reverted for ${SENDER}` },
    });
    await client.waitForUserOperationReceipt({ hash: USER_OP_HASH });
    expect(
      tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['blockchain.tx.revert.reason'],
    ).toBeUndefined();
  });

  it('ends as timeout when viem gives up, and rethrows its error', async () => {
    const { client } = await bundlerWith({ receipt: null });
    const error = await client
      .waitForUserOperationReceipt({ hash: USER_OP_HASH, timeout: 50, pollingInterval: 10 })
      .catch((e: unknown) => e);

    expect((error as Error).name).toBe('WaitForUserOperationReceiptTimeoutError');
    await vi.waitFor(() => tracing.spanNamed(`confirm ${CHAIN_ID}`));
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.attributes['error.type']).toBe('timeout');
    expect(confirm.attributes['blockchain.user_operation.success']).toBeUndefined();
  });

  it('ends as timeout when viem runs out of retries', async () => {
    const { client } = await bundlerWith({ receipt: null });
    const error = await client
      .waitForUserOperationReceipt({ hash: USER_OP_HASH, retryCount: 1, pollingInterval: 10 })
      .catch((e: unknown) => e);

    expect((error as Error).name).toBe('WaitForUserOperationReceiptTimeoutError');
    await vi.waitFor(() => tracing.spanNamed(`confirm ${CHAIN_ID}`));
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['error.type']).toBe('timeout');
  });

  it('records a failed request as a failure', async () => {
    const { client } = await bundlerWith({
      receiptError: { code: -32602, message: 'invalid params' },
    });
    const error = await client
      .waitForUserOperationReceipt({ hash: USER_OP_HASH })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    await vi.waitFor(() => tracing.spanNamed(`confirm ${CHAIN_ID}`));
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['error.type']).toBe(
      (error as Error).name,
    );
  });

  it('joins concurrent waits for one operation into one confirm span', async () => {
    const { hashspan, bundler, account } = await bundlerWith();
    // Separate clients: viem joins concurrent waits of one client itself, and a later wait on that client then hangs
    // (viem 2.57.2), with or without hashspan.
    const clientFor = () =>
      createBundlerClient({ account, chain: baseSepolia, transport: bundler.transport }).extend(
        hashspan,
      );
    await Promise.all([
      clientFor().waitForUserOperationReceipt({ hash: USER_OP_HASH }),
      clientFor().waitForUserOperationReceipt({ hash: USER_OP_HASH }),
    ]);
    await clientFor().waitForUserOperationReceipt({ hash: USER_OP_HASH });
    expect(tracing.spans().filter((s) => s.name === `confirm ${CHAIN_ID}`)).toHaveLength(1);
  });

  it('leaves a wait with an inherited or accessor hash untraced, and calls it once', async () => {
    const { client } = await bundlerWith();
    const inherited = Object.create({ hash: USER_OP_HASH }) as { hash: `0x${string}` };
    let reads = 0;
    const accessor = {
      get hash() {
        reads++;
        return USER_OP_HASH;
      },
    } as { hash: `0x${string}` };
    await client.waitForUserOperationReceipt(inherited);
    await client.waitForUserOperationReceipt(accessor);
    expect(reads).toBe(1);
    expect(tracing.spans()).toEqual([]);
  });

  it('ends a wait that is still running when flush() gives up', async () => {
    const { client, hashspan } = await bundlerWith({ receipt: null });
    const wait = client
      .waitForUserOperationReceipt({ hash: USER_OP_HASH, timeout: 0, pollingInterval: 10 })
      .catch(() => {});
    expect(await hashspan.flush({ timeoutMs: 30 })).toBe(false);
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['error.type']).toBe('timeout');
    void wait;
  });
});

describe('chain id of a bundler client', () => {
  it('takes the chain of the client the bundler client was created with', async () => {
    const bundler = mockBundler();
    const account = await stubAccount(bundler.transport);
    const reader = createPublicClient({ chain: baseSepolia, transport: bundler.transport });
    // A bundler client built by hand, without a chain of its own.
    const client = Object.assign(createClient({ account, transport: bundler.transport }), {
      client: reader,
    })
      .extend(bundlerActions)
      .extend(withHashspan());
    await client.sendUserOperation({ calls, ...GAS });
    expect(tracing.spanNamed(`send ${CHAIN_ID}`)).toBeDefined();
    expect(bundler.calls).not.toContain('eth_chainId');
  });

  it('records the spans after the call when no chain is known (ADR 0009)', async () => {
    const bundler = mockBundler();
    const account = await stubAccount(bundler.transport);
    const hashspan = withHashspan();
    const client = createBundlerClient({ account, transport: bundler.transport }).extend(hashspan);

    const hash = await client.sendUserOperation({ calls, ...GAS });
    await client.waitForUserOperationReceipt({ hash });
    expect(await hashspan.flush()).toBe(true);

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(send.attributes['blockchain.user_operation.hash']).toBe(USER_OP_HASH);
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes['blockchain.user_operation.success']).toBe(true);
  });

  it('records nothing when the chain id cannot be resolved', async () => {
    const bundler = mockBundler({
      chainId: () => {
        throw new Error('no chain id');
      },
    });
    const account = await stubAccount(bundler.transport);
    const hashspan = withHashspan();
    const client = createBundlerClient({ account, transport: bundler.transport }).extend(hashspan);

    const hash = await client.sendUserOperation({ calls, ...GAS });
    await client.waitForUserOperationReceipt({ hash });
    expect(await hashspan.flush()).toBe(true);
    expect(tracing.spans()).toEqual([]);
  });

  it('records a failed send without a chain once the chain id is known', async () => {
    const bundler = mockBundler({ sendError: { code: -32500, message: 'AA25 invalid nonce' } });
    const account = await stubAccount(bundler.transport);
    const hashspan = withHashspan();
    const client = createBundlerClient({ account, transport: bundler.transport }).extend(hashspan);

    await expect(client.sendUserOperation({ calls, ...GAS })).rejects.toThrow();
    expect(await hashspan.flush()).toBe(true);
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('extension', () => {
  it('adds the user operation actions only to clients that have them', () => {
    const wallet = createWalletClient({
      chain: baseSepolia,
      transport: mockBundler().transport,
    }).extend(withHashspan());
    expect('sendUserOperation' in wallet).toBe(false);
    expect('waitForUserOperationReceipt' in wallet).toBe(false);
  });

  it('records nothing for a tracker from a core without user operations, and calls work', async () => {
    const full = createTxTracker();
    const older = {
      startSend: full.startSend,
      startConfirm: full.startConfirm,
      startPayment: full.startPayment,
    } as unknown as TxTracker;
    const { client } = await bundlerWith({}, { tracker: older });
    const hash = await client.sendUserOperation({ calls, ...GAS });
    await client.waitForUserOperationReceipt({ hash });
    expect(tracing.spans()).toEqual([]);
  });

  it('never throws into the call when the tracker throws', async () => {
    const throwing = {
      ...createTxTracker(),
      startUserOperationSend: () => {
        throw new Error('broken tracker');
      },
      startUserOperationConfirm: () => {
        throw new Error('broken tracker');
      },
    } as TxTracker;
    const { client } = await bundlerWith({}, { tracker: throwing });
    const hash = await client.sendUserOperation({ calls, ...GAS });
    await expect(client.waitForUserOperationReceipt({ hash })).resolves.toMatchObject({
      success: true,
    });
  });
});
