// Smart account clients of SDKs (permissionless.js, ZeroDev): their `sendTransaction`, `writeContract` and
// `sendCalls` send a user operation through the client they closed over, so withHashspan() applied afterwards sees
// only an action that returns a hash. Such sends are not recorded as transactions or call batches; applied before the
// SDK's actions, withHashspan() records their user operations (#430, docs/adr/0021, amendment).
import { diag } from '@opentelemetry/api';
import { createClient, parseAbi } from 'viem';
import { bundlerActions, createBundlerClient } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { recordingMeterProvider } from './fault-checks.js';
import {
  BUNDLE_HASH,
  GAS,
  mockBundler,
  RECIPIENT,
  SENDER,
  stubAccount,
  USER_OP_HASH,
} from './mock-bundler.js';
import { sdkSmartAccountActions } from './sdk-smart-account.js';
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
const TOKEN_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const userOperationAttributes = (attributes: Record<string, unknown>) =>
  Object.keys(attributes).filter((key) => key.startsWith('blockchain.user_operation.'));

/** A smart account client as `createSmartAccountClient` builds it, with withHashspan() applied last. */
async function sdkClientExtendedLast(hashspanOptions = {}) {
  const bundler = mockBundler();
  const account = await stubAccount(bundler.transport);
  const meters = recordingMeterProvider();
  const hashspan = withHashspan({ meterProvider: meters.provider, ...hashspanOptions });
  const client = createBundlerClient({ account, chain: baseSepolia, transport: bundler.transport })
    .extend(sdkSmartAccountActions)
    .extend(hashspan);
  return { client, hashspan, bundler, account, meters };
}

describe('a smart account client extended last', () => {
  it('does not record sendTransaction as a transaction of the bundle', async () => {
    const { client, hashspan, bundler, meters } = await sdkClientExtendedLast({
      confirm: { mode: 'background' },
    });

    const hash = await client.sendTransaction({ to: RECIPIENT, value: 1n, ...GAS });
    await hashspan.flush();

    // The SDK's own result: the bundle transaction's hash.
    expect(hash).toBe(BUNDLE_HASH);
    expect(tracing.spans()).toEqual([]);
    expect(meters.recorded('blockchain.client.fee')).toEqual([]);
    // No background confirmation of the bundle transaction either.
    expect(bundler.calls).not.toContain('eth_getTransactionReceipt');
  });

  it('does not record writeContract as a transaction of the bundle', async () => {
    const { client, hashspan } = await sdkClientExtendedLast();

    const hash = await client.writeContract({
      address: RECIPIENT,
      abi: TOKEN_ABI,
      functionName: 'transfer',
      args: [SENDER, 1n],
      ...GAS,
    });
    await hashspan.flush();

    expect(hash).toBe(BUNDLE_HASH);
    expect(tracing.spans()).toEqual([]);
  });

  it('does not record sendCalls as a call batch', async () => {
    const { client, hashspan } = await sdkClientExtendedLast();

    const { id } = await client.sendCalls({ calls: [{ to: RECIPIENT, value: 1n }], ...GAS });
    await hashspan.flush();

    expect(id).toBe(USER_OP_HASH);
    expect(tracing.spans()).toEqual([]);
  });

  it('does not record a send whose own account is a smart account', async () => {
    const bundler = mockBundler();
    const account = await stubAccount(bundler.transport);
    // ZeroDev's client type, and no account on the client: only the call names the smart account.
    const client = createClient({
      chain: baseSepolia,
      transport: bundler.transport,
      type: 'kernelAccountClient',
    })
      .extend(bundlerActions)
      .extend(sdkSmartAccountActions)
      .extend(withHashspan());

    const hash = await client.sendTransaction({ account, to: RECIPIENT, value: 1n, ...GAS });

    expect(hash).toBe(BUNDLE_HASH);
    expect(tracing.spans()).toEqual([]);
  });

  it('still records sendUserOperation and waitForUserOperationReceipt called on it', async () => {
    const { client } = await sdkClientExtendedLast();

    const hash = await client.sendUserOperation({ calls: [{ to: RECIPIENT, value: 1n }], ...GAS });
    await client.waitForUserOperationReceipt({ hash });

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(send.attributes['blockchain.user_operation.hash']).toBe(USER_OP_HASH);
    expect(confirm.attributes['blockchain.user_operation.success']).toBe(true);
    expect(confirm.links.map((link) => link.context.spanId)).toEqual([send.spanContext().spanId]);
  });

  it('warns once per client that the smart account sends are not traced', async () => {
    const warn = vi.spyOn(diag, 'warn');
    const { client } = await sdkClientExtendedLast();

    await client.sendTransaction({ to: RECIPIENT, value: 1n, ...GAS });
    await client.sendCalls({ calls: [{ to: RECIPIENT, value: 1n }], ...GAS });

    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('smart account'),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('a smart account client with withHashspan() before the SDK actions', () => {
  async function sdkClientExtendedFirst() {
    const bundler = mockBundler();
    const account = await stubAccount(bundler.transport);
    const meters = recordingMeterProvider();
    const hashspan = withHashspan({ meterProvider: meters.provider });
    const client = createBundlerClient({
      account,
      chain: baseSepolia,
      transport: bundler.transport,
    })
      .extend(hashspan)
      .extend(sdkSmartAccountActions);
    return { client, hashspan, meters };
  }

  it('records the user operation of sendTransaction, sent and confirmed', async () => {
    const { client, hashspan, meters } = await sdkClientExtendedFirst();

    const hash = await client.sendTransaction({ to: RECIPIENT, value: 1n, ...GAS });
    await hashspan.flush();

    expect(hash).toBe(BUNDLE_HASH);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(send.attributes).toMatchObject({
      'blockchain.user_operation.hash': USER_OP_HASH,
      'blockchain.user_operation.sender': SENDER,
      'blockchain.user_operation.call_count': 1,
    });
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(confirm.attributes).toMatchObject({
      'blockchain.user_operation.hash': USER_OP_HASH,
      'blockchain.user_operation.gas.cost': (0x1cbe991a08).toString(),
      'blockchain.tx.hash': BUNDLE_HASH,
    });
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirm.attributes['blockchain.tx.fee']).toBeUndefined();
    expect(meters.recorded('blockchain.client.fee')).toEqual([
      {
        value: 0x1cbe991a08,
        attributes: expect.objectContaining({ 'blockchain.operation.subject': 'user_operation' }),
      },
    ]);
  });

  it('records the user operation of writeContract', async () => {
    const { client } = await sdkClientExtendedFirst();

    await client.writeContract({
      address: RECIPIENT,
      abi: TOKEN_ABI,
      functionName: 'transfer',
      args: [SENDER, 1n],
      ...GAS,
    });

    expect(tracing.spans().map((span) => span.name)).toEqual([
      `send ${CHAIN_ID}`,
      `confirm ${CHAIN_ID}`,
    ]);
    expect(userOperationAttributes(tracing.spanNamed(`send ${CHAIN_ID}`).attributes)).toContain(
      'blockchain.user_operation.hash',
    );
  });

  it('records the user operation of sendCalls as a send', async () => {
    const { client } = await sdkClientExtendedFirst();

    const { id } = await client.sendCalls({ calls: [{ to: RECIPIENT, value: 1n }], ...GAS });

    expect(id).toBe(USER_OP_HASH);
    const [send] = tracing.spans();
    expect(tracing.spans()).toHaveLength(1);
    expect(send?.attributes['blockchain.user_operation.hash']).toBe(USER_OP_HASH);
    expect(send?.attributes['blockchain.call_batch.id']).toBeUndefined();
  });
});
