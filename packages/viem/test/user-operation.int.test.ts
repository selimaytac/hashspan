// User operations on Anvil: viem's bundler client sends real operations through an in-process bundler stand-in
// (test-bundler.ts), which puts them into bundle transactions to a stand-in EntryPoint at the v0.7 address. What is
// real: viem's `sendUserOperation` and `waitForUserOperationReceipt`, the v0.7 user operation hash, nonces, the
// bundle transactions and their `UserOperationEvent` logs. What is not: signature validation, gas accounting and
// paymasters of a real EntryPoint, and a bundler's simulation (docs/adr/0021, Implementation notes).
import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  type Hex,
  http,
  RpcRequestError,
} from 'viem';
import {
  createBundlerClient,
  entryPoint07Abi,
  entryPoint07Address,
  toSmartAccount,
} from 'viem/account-abstraction';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  reverterCode,
  testAccountAbi,
  testAccountCode,
  testEntryPointCode,
} from './entry-point/test-entry-point.js';
import {
  collectingRejections,
  type Ending,
  expectEnding,
  failed,
  NO_OUTCOME,
  type Outcome,
  recordingMeterProvider,
  settle,
  succeeded,
  TIMEOUT,
} from './fault-checks.js';
import { freePort } from './free-port.js';
import { testBundler } from './test-bundler.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

const PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${PORT}`;
const ACCOUNT = '0x00000000000000000000000000000000000A11cE' as const;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const REVERTER = '0x00000000000000000000000000000000000000a1' as const;
const SIGNATURE = `0x${'11'.repeat(65)}` as const;
/** A nonce key in the upper 192 bits: the recorded nonce is then larger than any int attribute. */
const NONCE_KEY = 7n;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});
const reader = createPublicClient({ chain: anvil, transport: http(RPC_URL) });

let tracing: TestTracing;
let bundler: ReturnType<typeof testBundler>;

beforeAll(async () => {
  await instance.start();
  const setCode = (address: Address, code: Hex) =>
    reader.request({ method: 'anvil_setCode' as never, params: [address, code] as never });
  await setCode(entryPoint07Address, testEntryPointCode);
  await setCode(ACCOUNT, testAccountCode);
  await setCode(REVERTER, reverterCode);
  await reader.request({
    method: 'anvil_setBalance' as never,
    params: [ACCOUNT, '0xde0b6b3a7640000'] as never,
  });
  const [, executor] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address, Address];
  bundler = testBundler(
    reader,
    createWalletClient({ account: executor, chain: anvil, transport: http(RPC_URL) }),
  );
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

const smartAccount = () =>
  toSmartAccount({
    client: reader,
    entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: '0.7' },
    getAddress: async () => ACCOUNT,
    encodeCalls: async (calls) =>
      calls.length === 1
        ? encodeFunctionData({
            abi: testAccountAbi,
            functionName: 'execute',
            args: [calls[0]?.to as Address, calls[0]?.value ?? 0n, calls[0]?.data ?? '0x'],
          })
        : encodeFunctionData({
            abi: testAccountAbi,
            functionName: 'executeBatch',
            args: [
              calls.map((call) => ({
                target: call.to,
                value: call.value ?? 0n,
                data: call.data ?? '0x',
              })),
            ],
          }),
    getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
    getStubSignature: async () => SIGNATURE,
    signMessage: async () => SIGNATURE,
    signTypedData: async () => SIGNATURE,
    signUserOperation: async () => SIGNATURE,
  });

describe('user operations on Anvil', () => {
  it('traces an operation from the bundler to its receipt, apart from the bundle transaction', async () => {
    const account = await smartAccount();
    const hashspan = withHashspan();
    // The chain comes from the client the bundler client was created with.
    const client = createBundlerClient({
      account,
      client: reader,
      transport: bundler.transport,
      pollingInterval: 100,
    }).extend(hashspan);
    const before = await reader.getBalance({ address: RECIPIENT });
    const nonce = await account.getNonce({ key: NONCE_KEY });

    const hash = await client.sendUserOperation({
      calls: [
        { to: RECIPIENT, value: 1_000n },
        { to: RECIPIENT, value: 2_000n },
      ],
      nonce,
    });
    const receipt = await client.waitForUserOperationReceipt({ hash });
    // The bundle transaction's own receipt, through a traced public client: a separate confirm span.
    await createPublicClient({ chain: anvil, transport: http(RPC_URL) })
      .extend(hashspan)
      .waitForTransactionReceipt({ hash: receipt.receipt.transactionHash });

    expect(await reader.getBalance({ address: RECIPIENT })).toBe(before + 3_000n);
    expect(receipt.success).toBe(true);
    // The bundler returns the nonce as a hex string; viem 2.57 passes it on unchanged, typed as a bigint.
    expect([nonce, `0x${nonce.toString(16)}`]).toContain(receipt.nonce as unknown);

    const send = tracing.spanNamed('send 31337');
    const [confirm, bundle] = tracing.spans().filter((span) => span.name === 'confirm 31337');
    expect(send.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': 31337,
      'blockchain.operation.name': 'send',
      'blockchain.user_operation.sender': ACCOUNT.toLowerCase(),
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.user_operation.call_count': 2,
      'blockchain.user_operation.hash': hash,
    });
    expect(confirm?.links.map((link) => link.context.spanId)).toEqual([send.spanContext().spanId]);
    expect(confirm?.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': 31337,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': hash,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.used': Number(receipt.actualGasUsed),
      'blockchain.user_operation.gas.cost': receipt.actualGasCost.toString(),
      'blockchain.user_operation.sender': ACCOUNT.toLowerCase(),
      'blockchain.user_operation.nonce': nonce.toString(),
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.tx.hash': receipt.receipt.transactionHash,
      'blockchain.block.number': Number(receipt.receipt.blockNumber),
    });
    expect(nonce).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    // The bundle transaction keeps its own status and fee, on its own confirm span.
    expect(bundle?.attributes).toMatchObject({
      'blockchain.tx.hash': receipt.receipt.transactionHash,
      'blockchain.tx.status': 'success',
    });
    expect(bundle?.attributes['blockchain.tx.fee']).toBeDefined();
    expect(bundle?.attributes['blockchain.user_operation.hash']).toBeUndefined();
    expect(bundle?.links).toEqual([]);
  });

  it('records a reverted operation in a bundle transaction that succeeded', async () => {
    const account = await smartAccount();
    const client = createBundlerClient({
      account,
      client: reader,
      transport: bundler.transport,
      pollingInterval: 100,
    }).extend(withHashspan());

    // A bundler refuses to estimate an operation whose call reverts (as Alto does, real-bundler.int.test.ts) ...
    const refused = await client
      .sendUserOperation({ calls: [{ to: REVERTER, data: '0x' }] })
      .catch((error: unknown) => error);
    expect((refused as Error).name).toBe('UserOperationExecutionError');
    // viem before 2.21.58 words the bundler's error differently, with or without hashspan.
    if (viemAtLeast('2.21.58')) {
      expect((refused as { details?: string }).details).toMatch(
        /^UserOperation reverted during simulation with reason: 0x08c379a0/,
      );
    }
    expect(tracing.spanNamed('send 31337').attributes['error.type']).toBe(
      'UserOperationExecutionError',
    );
    tracing.exporter.reset();
    // ... so the sender gives the limits.
    const hash = await client.sendUserOperation({
      calls: [{ to: REVERTER, data: '0x' }],
      callGasLimit: 500_000n,
      verificationGasLimit: 200_000n,
      preVerificationGas: 50_000n,
    });
    const receipt = await client.waitForUserOperationReceipt({ hash });
    const bundle = await reader.getTransactionReceipt({ hash: receipt.receipt.transactionHash });

    expect(receipt.success).toBe(false);
    expect(bundle.status).toBe('success');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.user_operation.success': false,
      'error.type': 'reverted',
      'blockchain.tx.revert.reason': 'boom',
      'blockchain.tx.hash': receipt.receipt.transactionHash,
    });
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
  });

  // A bundler client with neither a chain nor a client prepares operations from viem 2.21.18 on.
  it.skipIf(!viemAtLeast('2.21.18'))(
    'records the spans of a bundler client without a chain once the chain id is known',
    async () => {
      const account = await smartAccount();
      const hashspan = withHashspan();
      const client = createBundlerClient({
        account,
        transport: bundler.transport,
        pollingInterval: 100,
      }).extend(hashspan);

      const hash = await client.sendUserOperation({ calls: [{ to: RECIPIENT, value: 1n }] });
      await client.waitForUserOperationReceipt({ hash });
      expect(await hashspan.flush()).toBe(true);

      const send = tracing.spanNamed('send 31337');
      const confirm = tracing.spanNamed('confirm 31337');
      expect(send.attributes['blockchain.user_operation.hash']).toBe(hash);
      expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
      expect(confirm.attributes['blockchain.user_operation.success']).toBe(true);
    },
  );
});

// RPC faults on the bundler methods of a user operation (issue #317), with the checks of rpc-faults.int.test.ts
// (fault-checks.ts). The in-process bundler cannot hang or drop a connection like an HTTP node: its methods fail with
// a JSON-RPC internal error, once or always, or the receipt stays null.
describe('bundler faults', () => {
  type BundlerFault = 'fails' | 'fails once' | 'stays null';
  /** The test bundler behind `faults`, per bundler method. */
  const faulty = (faults: Record<string, BundlerFault>) => {
    const counts = new Map<string, number>();
    return custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const fault = faults[method];
        const count = (counts.get(method) ?? 0) + 1;
        counts.set(method, count);
        if (fault === 'fails' || (fault === 'fails once' && count === 1)) {
          throw new RpcRequestError({
            body: { method },
            error: { code: -32603, message: 'internal error' },
            url: 'bundler',
          });
        }
        if (fault === 'stays null') return null;
        return bundler.transport({ chain: anvil }).request({ method, params } as never);
      },
    });
  };

  const USER_OPERATION_SUCCESS = 'blockchain.user_operation.success';
  // viem wraps a failure before or at the send in a UserOperationExecutionError; a receipt request that fails ends
  // the caller's wait, which keeps polling only while the receipt is missing.
  const rows: Record<
    string,
    { faults: Record<string, BundlerFault>; send: Ending; confirm?: Ending }
  > = {
    'eth_estimateUserOperationGas fails': {
      faults: { eth_estimateUserOperationGas: 'fails' },
      send: failed('UserOperationExecutionError'),
    },
    'eth_sendUserOperation fails': {
      faults: { eth_sendUserOperation: 'fails' },
      send: failed('UserOperationExecutionError'),
    },
    'eth_getUserOperationReceipt fails': {
      faults: { eth_getUserOperationReceipt: 'fails' },
      send: NO_OUTCOME,
      confirm: failed('InternalRpcError'),
    },
    'eth_getUserOperationReceipt fails once': {
      faults: { eth_getUserOperationReceipt: 'fails once' },
      send: NO_OUTCOME,
      confirm: succeeded(true),
    },
    'the receipt stays null': {
      faults: { eth_getUserOperationReceipt: 'stays null' },
      send: NO_OUTCOME,
      confirm: TIMEOUT,
    },
  };

  it.each(Object.keys(rows))('%s', async (row) => {
    const { faults, send, confirm } = rows[row] as (typeof rows)[string];
    const run = async (traced: boolean) => {
      const account = await smartAccount();
      const meters = recordingMeterProvider();
      const hashspan = withHashspan({ meterProvider: meters.provider });
      const plain = createBundlerClient({
        account,
        client: reader,
        transport: faulty(faults),
        pollingInterval: 50,
      });
      const client = traced ? plain.extend(hashspan) : plain;
      const sent = await settle(
        client.sendUserOperation({ calls: [{ to: RECIPIENT, value: 1n }] }),
      );
      const hash = 'resolved' in sent ? (sent.resolved as Hex) : undefined;
      const waited = hash
        ? await settle(
            client.waitForUserOperationReceipt({ hash, timeout: 2_500, retryCount: 0 } as never),
          )
        : undefined;
      return { sent, waited, meters, flushed: await hashspan.flush({ timeoutMs: 5_000 }) };
    };
    /** What the caller got, without the hashes and receipts that differ between runs. */
    const shape = (outcome: Outcome | undefined) =>
      outcome && ('rejected' in outcome ? outcome.rejected.name : 'resolved');
    const untraced = await run(false);
    const [traced, rejections] = await collectingRejections(() => run(true));

    expect([shape(traced.sent), shape(traced.waited)]).toEqual([
      shape(untraced.sent),
      shape(untraced.waited),
    ]);
    expect(rejections).toEqual([]);
    expect(traced.flushed).toBe(true);
    const sends = tracing.spans().filter((s) => s.name === 'send 31337');
    const confirms = tracing.spans().filter((s) => s.name === 'confirm 31337');
    expect(sends).toHaveLength(1);
    expectEnding(sends[0], send, USER_OPERATION_SUCCESS);
    expect(confirms).toHaveLength(confirm ? 1 : 0);
    if (confirm) expectEnding(confirms[0], confirm, USER_OPERATION_SUCCESS);
    expect(traced.meters.recorded('blockchain.client.send.duration')).toHaveLength(1);
    expect(traced.meters.recorded('blockchain.client.confirmation.duration')).toHaveLength(
      confirm ? 1 : 0,
    );
  });
});
