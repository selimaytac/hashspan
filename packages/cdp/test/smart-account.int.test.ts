// Smart account user operations through the real CDP SDK, against the local CDP API stand-in (mock-cdp-api.ts),
// which builds each operation for the stand-in EntryPoint at the v0.7 address and puts it into a bundle transaction
// on Anvil. What is real: the SDK's smart account methods and waits, the v0.7 user operation hash, the bundle
// transactions and their `UserOperationEvent` logs, which the reader reads. What is not: CDP's bundler and
// paymaster, signature validation and gas accounting (docs/adr/0021, Implementation notes).
import { SpanStatusCode } from '@opentelemetry/api';
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  http,
  pad,
  zeroAddress,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reverterCode,
  testAccountAbi,
  testAccountCode,
  testEntryPointAbi,
  testEntryPointCode,
} from '../../viem/test/entry-point/test-entry-point.js';
import { collectingRejections, type Faults, faultsOn } from '../../viem/test/fault-checks.js';
import { type FaultProxy, startFaultProxy } from '../../viem/test/fault-proxy.js';
import { startAnvil } from '../../viem/test/start-anvil.js';
import { withHashspan } from '../src/index.js';
import { startMockCdpApi, throwawayCredentials } from './mock-cdp-api.js';
import { setupTracing, type TestTracing } from './tracing.js';

const SMART_ACCOUNT = '0x00000000000000000000000000000000000A11cE' as const;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const REVERTER = '0x00000000000000000000000000000000000000a1' as const;
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000b0b' as const;
const EMITTER = '0x00000000000000000000000000000000000000e1' as const;
/**
 * Runtime code that logs its call data as one event: four topics (the first 128 bytes), then the data. Hand-assembled:
 * CALLDATASIZE PUSH1 0x80 SWAP1 SUB DUP1 PUSH1 0x80 PUSH1 0 CALLDATACOPY, CALLDATALOAD at 0x60, 0x40, 0x20 and 0,
 * DUP5 PUSH1 0 LOG4 STOP.
 */
const EMITTER_CODE = '0x3660809003806080600037606035604035602035600035846000a400' as const;

// Keep the SDK's own usage tracking and error reporting off: tests make no request outside localhost.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';

// Anvil with Base Sepolia's chain id, so the real CDP network name applies; on `base`, the SDK would default the
// paymaster to CDP's node.
const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: 84532,
});
const reader = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
  pollingInterval: 50,
});

let api: Awaited<ReturnType<typeof startMockCdpApi>>;
let tracing: TestTracing;
const fetched: string[] = [];

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (!url.startsWith('http://127.0.0.1'))
      return Promise.resolve(new Response(null, { status: 204 }));
    return realFetch(input, init);
  });
  const setCode = (address: Address, code: Hex) =>
    reader.request({ method: 'anvil_setCode' as never, params: [address, code] as never });
  await setCode(entryPoint07Address, testEntryPointCode);
  await setCode(SMART_ACCOUNT, testAccountCode);
  await setCode(OTHER_ACCOUNT, testAccountCode);
  await setCode(REVERTER, reverterCode);
  await setCode(EMITTER, EMITTER_CODE);
  await reader.request({
    method: 'anvil_setBalance' as never,
    params: [SMART_ACCOUNT, '0xde0b6b3a7640000'] as never,
  });
  const [owner, bundler] = (await createWalletClient({
    transport: http(RPC_URL),
  }).getAddresses()) as [Address, Address];
  api = await startMockCdpApi({
    rpcUrl: RPC_URL,
    account: owner,
    smartAccount: SMART_ACCOUNT,
    bundler,
  });
});
afterAll(async () => {
  await api.close();
  await instance.stop();
  vi.restoreAllMocks();
  expect(fetched.filter((url) => !url.startsWith('http://127.0.0.1'))).toEqual([]);
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const smartAccount = async (options: { reader?: boolean } = {}) => {
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient({ ...throwawayCredentials(), basePath: api.basePath });
  const hashspan = withHashspan(cdp, options.reader === false ? {} : { reader });
  const owner = await cdp.evm.createAccount();
  const account = await cdp.evm.createSmartAccount({ owner });
  return { cdp, hashspan, account };
};

describe('CDP smart accounts against a local CDP API and Anvil', () => {
  it('traces a user operation from send to its UserOperationEvent', async () => {
    const { hashspan, account } = await smartAccount();
    const { userOpHash } = await account.sendUserOperation({
      network: 'base-sepolia',
      calls: [
        { to: RECIPIENT, value: 1n, data: '0x' },
        { to: RECIPIENT, value: 2n, data: '0x' },
      ],
    });
    const result = await account.waitForUserOperation({ userOpHash });
    expect(result.status).toBe('complete');
    await expect(hashspan.flush()).resolves.toBe(true);

    const send = tracing.spanNamed('send 84532');
    expect(send.attributes).toMatchObject({
      'blockchain.user_operation.hash': userOpHash,
      'blockchain.user_operation.sender': SMART_ACCOUNT.toLowerCase(),
      'blockchain.user_operation.call_count': 2,
    });
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm.attributes).toMatchObject({
      'blockchain.user_operation.hash': userOpHash,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.user_operation.nonce': '0',
      'blockchain.tx.hash': result.status === 'complete' ? result.transactionHash : undefined,
    });
    expect(confirm.attributes['blockchain.user_operation.gas.cost']).toMatch(/^\d+$/);
    expect(confirm.attributes['blockchain.tx.fee']).toBeUndefined();
    // A user operation's wait takes no count (#414).
    expect(confirm.attributes).not.toHaveProperty('blockchain.tx.wait.confirmations');
    expect(await reader.getBalance({ address: RECIPIENT })).toBeGreaterThanOrEqual(3n);
  });

  it('records a reverted operation in a mined bundle, which only the reader can tell', async () => {
    const { hashspan, account } = await smartAccount();
    const { userOpHash } = await account.sendUserOperation({
      network: 'base-sepolia',
      calls: [{ to: REVERTER, value: 0n, data: '0x' }],
    });
    // The stand-in reports `complete` once the bundle is mined, whatever the operation's outcome.
    await expect(account.waitForUserOperation({ userOpHash })).resolves.toMatchObject({
      status: 'complete',
    });
    await hashspan.flush();
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['error.type']).toBe('reverted');
    expect(confirm.attributes['blockchain.user_operation.success']).toBe(false);
  });

  it("reads the operation's outcome from the EntryPoint in a bundle it shares with a later operation", async () => {
    const { hashspan, account } = await smartAccount();
    // The later operation, of another sender, calls a contract that logs an event with the same topics.
    api.shareNextBundle(async (userOpHash) => [
      {
        sender: OTHER_ACCOUNT,
        nonce: 0n,
        initCode: '0x',
        callData: encodeFunctionData({
          abi: testAccountAbi,
          functionName: 'executeBatch',
          args: [
            [
              {
                target: EMITTER,
                value: 0n,
                data: concat([
                  ...encodeEventTopics({
                    abi: testEntryPointAbi,
                    eventName: 'UserOperationEvent',
                    args: { userOpHash, sender: SMART_ACCOUNT, paymaster: zeroAddress },
                  }),
                  encodeAbiParameters(
                    [
                      { type: 'uint256' },
                      { type: 'bool' },
                      { type: 'uint256' },
                      { type: 'uint256' },
                    ],
                    [0n, true, 1n, 1n],
                  ),
                ]),
              },
            ],
          ],
        }),
        accountGasLimits: pad('0x', { size: 32 }),
        preVerificationGas: 50_000n,
        gasFees: pad('0x', { size: 32 }),
        paymasterAndData: '0x',
        signature: '0x',
      },
    ]);
    const { userOpHash } = await account.sendUserOperation({
      network: 'base-sepolia',
      calls: [{ to: REVERTER, value: 0n, data: '0x' }],
    });
    const result = await account.waitForUserOperation({ userOpHash });
    expect(result.status).toBe('complete');
    await hashspan.flush();

    // The bundle carries both logs, the later one from the other contract.
    const bundle = await reader.getTransactionReceipt({
      hash: (result as { transactionHash: Hex }).transactionHash,
    });
    const emitters = bundle.logs
      .filter((log) => log.topics[1] === userOpHash && log.topics.length === 4)
      .map((log) => log.address);
    expect(emitters).toEqual([entryPoint07Address.toLowerCase(), EMITTER.toLowerCase()]);
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'error.type': 'reverted',
      'blockchain.user_operation.success': false,
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
    });
    expect(confirm.attributes['blockchain.user_operation.gas.cost']).not.toBe('1');
  });

  it('records the bundle hash without a reader, and a failed operation as failed', async () => {
    const { cdp, hashspan, account } = await smartAccount({ reader: false });
    const first = await account.transfer({
      network: 'base-sepolia',
      to: RECIPIENT,
      amount: 1n,
      token: 'eth',
    });
    const completed = await cdp.evm.waitForUserOperation({
      userOpHash: first.userOpHash,
      smartAccountAddress: account.address,
    });
    api.failNextUserOperation();
    const second = await account.sendUserOperation({
      network: 'base-sepolia',
      calls: [{ to: RECIPIENT, value: 1n, data: '0x' }],
    });
    await expect(
      account.waitForUserOperation({ userOpHash: second.userOpHash }),
    ).resolves.toMatchObject({
      status: 'failed',
    });
    await hashspan.flush();

    const byHash = (hash: string) =>
      tracing
        .spans()
        .find(
          (s) =>
            s.name === 'confirm 84532' && s.attributes['blockchain.user_operation.hash'] === hash,
        );
    const ok = byHash(first.userOpHash);
    expect(ok?.attributes['blockchain.tx.hash']).toBe(
      completed.status === 'complete' ? completed.transactionHash : undefined,
    );
    expect(ok?.attributes['blockchain.user_operation.success']).toBeUndefined();
    expect(ok?.status.code).toBe(SpanStatusCode.UNSET);
    const failed = byHash(second.userOpHash);
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.attributes['error.type']).toBe('failed');
  });
});

describe('a user operation whose reader fails while reading the bundle receipt', () => {
  // The reader is only asked for the bundle transaction's receipt, to tell whether the operation's calls succeeded
  // (ADR 0021). When it cannot be read before `confirmTimeoutMs`, the confirm span ends as without a reader: the
  // bundle hash CDP reported, no `blockchain.user_operation.success`, no error (issue #317).
  let proxy: FaultProxy;
  beforeAll(async () => {
    proxy = await startFaultProxy(RPC_URL);
  });
  afterAll(async () => {
    await proxy.stop();
  });
  const rows: Record<string, { faults: Faults; success: boolean | undefined }> = {
    ...Object.fromEntries(
      Object.entries(faultsOn('eth_getTransactionReceipt')).map(([fault, faults]) => [
        fault,
        { faults, success: undefined },
      ]),
    ),
    'a receipt that stays null': {
      faults: { eth_getTransactionReceipt: { kind: 'result', result: () => null } },
      success: undefined,
    },
    'one failed receipt request before the receipt': {
      faults: {
        eth_getTransactionReceipt: [{ fault: { kind: 'rpc-error', code: -32603 }, times: 1 }],
      },
      success: true,
    },
  };

  /** Sends and waits for one operation; `faults` apply to the reader once the operation was sent. */
  async function sendAndWait(faults: Faults, traced: boolean) {
    proxy.set({});
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    const cdp = new CdpClient({ ...throwawayCredentials(), basePath: api.basePath });
    const faultyReader = createPublicClient({
      chain: baseSepolia,
      transport: http(proxy.url, { retryCount: 0, timeout: 1_000 }),
      pollingInterval: 50,
    });
    const hashspan = traced
      ? withHashspan(cdp, { reader: faultyReader, confirmTimeoutMs: 2_500 })
      : undefined;
    const owner = await cdp.evm.createAccount();
    const account = await cdp.evm.createSmartAccount({ owner });
    const { userOpHash } = await account.sendUserOperation({
      network: 'base-sepolia',
      calls: [{ to: RECIPIENT, value: 1n, data: '0x' }],
    });
    proxy.set(faults);
    const result = await account.waitForUserOperation({ userOpHash });
    return { result, flushed: await hashspan?.flush({ timeoutMs: 10_000 }) };
  }

  it.each(Object.keys(rows))('%s', async (row) => {
    const { faults, success } = rows[row] as (typeof rows)[string];
    const untraced = await sendAndWait(faults, false);
    const [{ result, flushed }, rejections] = await collectingRejections(() =>
      sendAndWait(faults, true),
    );

    expect(result.status).toBe(untraced.result.status);
    expect(rejections).toEqual([]);
    expect(flushed).toBe(true);
    expect(tracing.spanNamed('send 84532').status.code).toBe(SpanStatusCode.UNSET);
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm.attributes['error.type']).toBeUndefined();
    expect(confirm.attributes['blockchain.user_operation.success']).toBe(success);
    expect(confirm.attributes['blockchain.tx.hash']).toBe(
      result.status === 'complete' ? result.transactionHash : undefined,
    );
  });
});
