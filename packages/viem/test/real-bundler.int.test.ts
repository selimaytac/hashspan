// User operations through a real ERC-4337 bundler: Alto, run as a separate process against Anvil, with the canonical
// EntryPoint v0.7 deployed at its canonical address and SimpleAccount smart accounts. Both are installed outside the
// pnpm workspace by scripts/install-bundler.sh (`make tools`). Alto listens on every network interface (its host is
// fixed to 0.0.0.0), so the file runs only in CI or when HASHSPAN_REAL_BUNDLER=1 is set, not on every local test run.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import {
  type Address,
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  type Hex,
  http,
  parseAbi,
  parseEther,
  zeroHash,
} from 'viem';
import {
  createBundlerClient,
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
  toSmartAccount,
} from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { reverterCode } from './entry-point/test-entry-point.js';
import { freePort } from './free-port.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RUN = Boolean(process.env.CI || process.env.HASHSPAN_REAL_BUNDLER);
const ANVIL_PORT = await freePort();
const ALTO_PORT = await freePort();
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const BUNDLER_URL = `http://127.0.0.1:${ALTO_PORT}`;
const TOOLS = new URL('../../../.tools/bundler/node_modules/', import.meta.url).pathname;
const ALTO = `${TOOLS}@pimlico/alto/esm/cli/alto.js`;
const ARTIFACTS = `${TOOLS}@account-abstraction/contracts/artifacts/`;
// Throwaway keys, funded on Anvil before Alto starts: one sends bundles, one deploys Alto's simulation contracts, one
// owns the smart accounts (it only signs).
const executorKey = generatePrivateKey();
const utilityKey = generatePrivateKey();
const owner = privateKeyToAccount(generatePrivateKey());
// The deterministic deployer Anvil ships with, and the salt the EntryPoint v0.7 was deployed with on every chain.
const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const ENTRY_POINT_SALT = '0x90d8084deab30c2a37c45e8d47f49f2f7965183cb6990a98943ef94940681de3';
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const REVERTER = '0x00000000000000000000000000000000000000a1' as const;
// A valid signature of another message: it recovers to an address, so validation reports a wrong signature instead of
// reverting in OpenZeppelin's ECDSA, as a malformed one would during gas estimation.
const stubSignature = owner.signMessage({ message: 'stub' });

const factoryAbi = parseAbi([
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
]);
const simpleAccountAbi = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
]);

const creationCode = (name: string): Hex =>
  (JSON.parse(readFileSync(`${ARTIFACTS}${name}.json`, 'utf8')) as { bytecode: Hex }).bytecode;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: ANVIL_PORT,
});
const reader = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
const testClient = createTestClient({ chain: anvil, mode: 'anvil', transport: http(RPC_URL) });
const nodeWallet = createWalletClient({ chain: anvil, transport: http(RPC_URL) });

let tracing: TestTracing;
let factory: Address;
let alto: ChildProcess | undefined;
let altoLog = '';

/** Deploys `initCode` through the deterministic deployer and returns its address. */
async function deploy(initCode: Hex, salt: Hex): Promise<Address> {
  const address = getContractAddress({
    opcode: 'CREATE2',
    from: DEPLOYER,
    salt,
    bytecode: initCode,
  });
  // Anvil's first account, unlocked on the node.
  const [deployer] = (await nodeWallet.getAddresses()) as [Address];
  const hash = await nodeWallet.sendTransaction({
    account: deployer,
    to: DEPLOYER,
    data: concat([salt, initCode]),
  });
  await reader.waitForTransactionReceipt({ hash });
  if ((await reader.getCode({ address })) === undefined) throw new Error(`no code at ${address}`);
  return address;
}

/** Starts Alto and resolves once it listens. Its working directory is the tool directory, so it reads no `.env`. */
async function startAlto(): Promise<void> {
  const args = {
    entrypoints: entryPoint07Address,
    'rpc-url': RPC_URL,
    port: String(ALTO_PORT),
    'executor-private-keys': executorKey,
    'utility-private-key': utilityKey,
    // Safe mode traces validation with a JavaScript tracer, which Anvil does not have.
    'safe-mode': 'false',
    'deploy-simulations-contract': 'true',
    'block-time': '100',
    'min-bundle-interval': '50',
    'max-bundle-interval': '100',
    'log-level': 'warn',
  };
  const child = spawn(
    process.execPath,
    [ALTO, ...Object.entries(args).flatMap(([key, value]) => [`--${key}`, value])],
    { cwd: TOOLS, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  alto = child;
  const onData = (data: Buffer) => {
    altoLog += data.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<never>((_, reject) =>
    child.once('exit', (code) => reject(new Error(`alto exited with ${code}:\n${altoLog}`))),
  );
  exited.catch(() => {});
  // Alto deploys its simulation contracts before it listens; it is ready once it answers.
  const ready = (async () => {
    for (;;) {
      try {
        const response = await fetch(BUNDLER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        });
        if (response.ok) return;
      } catch {}
      if (child.exitCode !== null) return exited;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  await Promise.race([ready, exited]);
}

beforeAll(async () => {
  if (!RUN) return;
  if (!existsSync(ALTO)) throw new Error('Alto is not installed: run ./scripts/install-bundler.sh');
  await instance.start();
  const entryPoint = await deploy(creationCode('EntryPoint'), ENTRY_POINT_SALT);
  expect(entryPoint).toBe(entryPoint07Address);
  factory = await deploy(
    concat([
      creationCode('SimpleAccountFactory'),
      encodeAbiParameters([{ type: 'address' }], [entryPoint07Address]),
    ]),
    zeroHash,
  );
  await testClient.setCode({ address: REVERTER, bytecode: reverterCode });
  for (const key of [executorKey, utilityKey])
    await testClient.setBalance({
      address: privateKeyToAccount(key).address,
      value: parseEther('100'),
    });
  await startAlto();
});
afterAll(async () => {
  if (!RUN) return;
  alto?.kill();
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** A SimpleAccount v0.7 of `owner`, deployed by its first operation and funded to pay for its operations. */
async function simpleAccount(salt: bigint) {
  const address = await reader.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'getAddress',
    args: [owner.address, salt],
  });
  await testClient.setBalance({ address, value: parseEther('1') });
  return toSmartAccount({
    client: reader,
    entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: '0.7' },
    getAddress: async () => address,
    encodeCalls: async (calls) =>
      calls.length === 1
        ? encodeFunctionData({
            abi: simpleAccountAbi,
            functionName: 'execute',
            args: [calls[0]?.to as Address, calls[0]?.value ?? 0n, calls[0]?.data ?? '0x'],
          })
        : encodeFunctionData({
            abi: simpleAccountAbi,
            functionName: 'executeBatch',
            args: [
              calls.map((call) => call.to),
              calls.map((call) => call.value ?? 0n),
              calls.map((call) => call.data ?? '0x'),
            ],
          }),
    getFactoryArgs: async () => ({
      factory,
      factoryData: encodeFunctionData({
        abi: factoryAbi,
        functionName: 'createAccount',
        args: [owner.address, salt],
      }),
    }),
    getStubSignature: () => stubSignature,
    signMessage: async ({ message }) => owner.signMessage({ message }),
    signTypedData: async (typedData) => owner.signTypedData(typedData as never),
    signUserOperation: async ({ chainId = anvil.id, ...userOperation }) =>
      owner.signMessage({
        message: {
          raw: getUserOperationHash({
            chainId,
            entryPointAddress: entryPoint07Address,
            entryPointVersion: '0.7',
            userOperation: { ...userOperation, sender: address },
          }),
        },
      }),
  });
}

async function bundlerClient(salt: bigint, hashspan = withHashspan()) {
  return createBundlerClient({
    account: await simpleAccount(salt),
    client: reader,
    transport: http(BUNDLER_URL),
    pollingInterval: 100,
  }).extend(hashspan);
}

/** What Alto answers to `eth_getUserOperationReceipt`, before viem formats it. */
type RawReceipt = Record<string, unknown> & { receipt: Record<string, unknown> };
const rawReceipt = (hash: Hex) =>
  createBundlerClient({ transport: http(BUNDLER_URL) }).request({
    method: 'eth_getUserOperationReceipt',
    params: [hash],
  }) as Promise<RawReceipt | null>;

describe.skipIf(!RUN)('user operations through Alto on Anvil', () => {
  it('traces an operation that deploys its account, from the bundler to its receipt', async () => {
    const client = await bundlerClient(1n);
    const before = await reader.getBalance({ address: RECIPIENT });

    const hash = await client.sendUserOperation({
      calls: [
        { to: RECIPIENT, value: 1_000n },
        { to: RECIPIENT, value: 2_000n },
      ],
    });
    const receipt = await client.waitForUserOperationReceipt({ hash });

    expect(await reader.getBalance({ address: RECIPIENT })).toBe(before + 3_000n);
    expect(receipt.success).toBe(true);
    // Alto's answer, which test-bundler.ts imitates: the nonce and gas as hex strings, the EntryPoint lower-cased, no
    // paymaster when none paid, and a bundle receipt of its own making rather than the node's.
    const raw = await rawReceipt(hash);
    expect(raw).toMatchObject({
      entryPoint: entryPoint07Address.toLowerCase(),
      nonce: expect.stringMatching(/^0x[0-9a-f]+$/),
      actualGasCost: expect.stringMatching(/^0x[0-9a-f]+$/),
      success: true,
    });
    expect(raw).not.toHaveProperty('paymaster');
    expect(raw).not.toHaveProperty('reason');
    expect(raw?.receipt.status).toBe('0x1');

    const account = client.account.address;
    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(send.status.code).toBe(SpanStatusCode.UNSET);
    expect(send.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': 31337,
      'blockchain.operation.name': 'send',
      'blockchain.user_operation.sender': account.toLowerCase(),
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.user_operation.call_count': 2,
      'blockchain.user_operation.hash': hash,
    });
    expect(confirm.links.map((link) => link.context.spanId)).toEqual([send.spanContext().spanId]);
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm.attributes).toEqual({
      'blockchain.system': 'evm',
      'blockchain.chain.id': 31337,
      'blockchain.operation.name': 'confirm',
      'blockchain.user_operation.hash': hash,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.gas.used': Number(receipt.actualGasUsed),
      'blockchain.user_operation.gas.cost': receipt.actualGasCost.toString(),
      'blockchain.user_operation.sender': account.toLowerCase(),
      'blockchain.user_operation.nonce': BigInt(receipt.nonce).toString(),
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.tx.hash': receipt.receipt.transactionHash,
      'blockchain.block.number': Number(receipt.receipt.blockNumber),
    });
    // One form for each address on both spans, although viem gives the EntryPoint checksummed and Alto lower-cased.
    for (const key of [
      'blockchain.user_operation.sender',
      'blockchain.user_operation.entry_point',
    ]) {
      expect(confirm.attributes[key]).toBe(send.attributes[key]);
    }
    // The operation's own cost, from its UserOperationEvent, not the fee of the bundle transaction.
    const bundle = await reader.getTransactionReceipt({ hash: receipt.receipt.transactionHash });
    expect(receipt.actualGasCost).not.toBe(bundle.gasUsed * bundle.effectiveGasPrice);
  });

  it('records a reverted operation in a bundle transaction that succeeded', async () => {
    const client = await bundlerClient(2n);
    // Alto simulates the call when it estimates gas and refuses one that reverts, so the limits are given.
    const { verificationGasLimit, preVerificationGas } = await client.prepareUserOperation({
      calls: [{ to: RECIPIENT, value: 1n }],
    });

    const hash = await client.sendUserOperation({
      calls: [{ to: REVERTER, data: '0x' }],
      callGasLimit: 200_000n,
      verificationGasLimit,
      preVerificationGas,
    });
    const receipt = await client.waitForUserOperationReceipt({ hash });
    const bundle = await reader.getTransactionReceipt({ hash: receipt.receipt.transactionHash });

    expect(receipt.success).toBe(false);
    expect(bundle.status).toBe('success');
    // Alto returns the revert data of the call as `reason`.
    expect((await rawReceipt(hash))?.reason).toMatch(/^0x08c379a0/);
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

  it('ends the send span with the error when the bundler refuses an operation that would revert', async () => {
    const client = await bundlerClient(3n);

    const error = await client
      .sendUserOperation({ calls: [{ to: REVERTER, data: '0x' }] })
      .catch((caught: unknown) => caught);

    expect((error as Error).name).toBe('UserOperationExecutionError');
    expect((error as { details?: string }).details).toMatch(
      /^UserOperation reverted during simulation with reason: 0x08c379a0/,
    );
    const send = tracing.spanNamed('send 31337');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe('UserOperationExecutionError');
    expect(send.attributes['blockchain.user_operation.hash']).toBeUndefined();
    expect(tracing.spans().filter((span) => span.name === 'confirm 31337')).toEqual([]);
  });

  it('ends as timeout when the wait gives up while the bundle is pending', async () => {
    const client = await bundlerClient(4n);
    await testClient.setAutomine(false);
    try {
      const executor = privateKeyToAccount(executorKey).address;
      const mined = await reader.getTransactionCount({ address: executor, blockTag: 'latest' });
      const hash = await client.sendUserOperation({ calls: [{ to: RECIPIENT, value: 1n }] });
      // Once Alto's bundle transaction waits in the node's pool, Alto has no receipt for the operation.
      await expect
        .poll(() => reader.getTransactionCount({ address: executor, blockTag: 'pending' }), {
          timeout: 10_000,
        })
        .toBeGreaterThan(mined);
      expect(await rawReceipt(hash)).toBeNull();

      const error = await client
        .waitForUserOperationReceipt({ hash, timeout: 1_000 })
        .catch((caught: unknown) => caught);

      expect((error as Error).name).toBe('WaitForUserOperationReceiptTimeoutError');
      const confirm = tracing.spanNamed('confirm 31337');
      expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
      expect(confirm.attributes).toMatchObject({
        'blockchain.user_operation.hash': hash,
        'error.type': 'timeout',
      });
      expect(confirm.attributes['blockchain.tx.hash']).toBeUndefined();

      // Mined later, the operation completes; the span that gave up stays as it ended.
      await testClient.mine({ blocks: 1 });
      await expect
        .poll(async () => (await rawReceipt(hash))?.success, { timeout: 10_000 })
        .toBe(true);
      expect(tracing.spans().filter((span) => span.name === 'confirm 31337')).toHaveLength(1);
    } finally {
      await testClient.setAutomine(true);
    }
  });
});
