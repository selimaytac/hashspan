// Smart account clients of permissionless.js and ZeroDev with hashspan, against Anvil (#430): the setup of
// docs/integrations.md (readme/permissionless.ts) run as written, and the SDKs' own clients with withHashspan()
// applied last. User operations go through packages/viem/test/test-bundler.ts to the stand-in EntryPoint, with a
// stand-in account (smart-account-setup.ts); what that does not cover is in packages/viem/test/user-operation.int.test.ts.
// Nothing leaves localhost (see offline.ts, a setup file).
import { type HashspanExtension, withHashspan } from '@hashspan/viem';
import { createKernelAccountClient } from '@zerodev/sdk';
import { createSmartAccountClient } from 'permissionless';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { testBundler } from '../../packages/viem/test/test-bundler.js';
import { installTestEntryPoint } from '../../packages/viem/test/test-smart-account.js';
import { setupTracing, type TestTracing } from '../../packages/viem/test/tracing.js';
import { offline } from './offline.js';
import { ANVIL_URL, account, bundlerUrl, SMART_ACCOUNT } from './smart-account-setup.js';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const CHAIN = `${foundry.id}`;

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: foundry.id,
});
const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
let bundler: ReturnType<typeof testBundler>;
let tracing: TestTracing;

// The example's URLs: the Anvil URL goes to this file's Anvil, the bundler URL to the in-process bundler.
const offlineFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  // Origins compared whole: a prefix of the bundler URL's could match Anvil's own port.
  const { origin } = new URL(url);
  if (origin === new URL(ANVIL_URL).origin) return offlineFetch(rpcUrl, init);
  if (origin !== new URL(bundlerUrl).origin) return offlineFetch(input, init);
  const { id, method, params } = JSON.parse(String(init?.body));
  try {
    const result = await bundler.transport({ chain: foundry }).request({ method, params });
    return Response.json({ jsonrpc: '2.0', id, result });
  } catch (error) {
    const { code = -32603, message } = error as { code?: number; message: string };
    return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
  }
});

beforeAll(async () => {
  await installTestEntryPoint(reader, SMART_ACCOUNT);
  // Anvil's third account sends the bundles: the second is the example's recipient.
  const [, , executor] = (await createWalletClient({
    chain: foundry,
    transport: http(rpcUrl),
  }).getAddresses()) as [Address, Address, Address];
  bundler = testBundler(
    reader,
    createWalletClient({ account: executor, chain: foundry, transport: http(rpcUrl) }),
  );
});
beforeEach(() => {
  tracing = setupTracing();
  return () => tracing.teardown();
});
afterAll(async () => {
  vi.stubGlobal('fetch', offlineFetch);
  await instance.stop();
});

/** The actions of an SDK's smart account client these tests call, with the arguments they pass. */
interface SdkClient {
  sendTransaction(args: { to: Address; value: bigint }): Promise<Hex>;
  writeContract(args: {
    address: Address;
    abi: typeof TOKEN_ABI;
    functionName: 'transfer';
    args: [Address, bigint];
  }): Promise<Hex>;
  sendCalls(args: { calls: { to: Address; value: bigint }[] }): Promise<{ id: Hex }>;
  sendUserOperation(args: { calls: { to: Address; value: bigint }[] }): Promise<Hex>;
  waitForUserOperationReceipt(args: { hash: Hex }): Promise<{ receipt: { transactionHash: Hex } }>;
}

/**
 * `client.extend(hashspan)` on an SDK's finished client. viem's `extend()` types require an extension's
 * `sendTransaction` to have viem's signature, and the extension returns the SDK's: TypeScript rejects it without a
 * cast, while the call itself works. The SDKs' own types for a stand-in account are loose, so the client is typed with
 * the actions the tests call.
 */
const extendLast = (client: { extend: unknown }, hashspan: HashspanExtension): SdkClient =>
  (client.extend as (extension: unknown) => SdkClient)(hashspan);

/** The user operation spans: a send, and a confirm linked to it. */
function expectUserOperationSpans(bundleHash: string) {
  expect(tracing.spans().map((span) => span.name)).toEqual([`send ${CHAIN}`, `confirm ${CHAIN}`]);
  const send = tracing.spanNamed(`send ${CHAIN}`);
  const confirm = tracing.spanNamed(`confirm ${CHAIN}`);
  const userOpHash = send.attributes['blockchain.user_operation.hash'];
  expect(send.attributes).toMatchObject({
    'blockchain.user_operation.sender': SMART_ACCOUNT.toLowerCase(),
    'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
    'blockchain.user_operation.call_count': 1,
  });
  expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(send.attributes['blockchain.tx.from']).toBeUndefined();
  expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
  expect(confirm.links.map((link) => link.context.spanId)).toEqual([send.spanContext().spanId]);
  expect(confirm.attributes).toMatchObject({
    'blockchain.user_operation.hash': userOpHash,
    'blockchain.user_operation.success': true,
    'blockchain.tx.hash': bundleHash,
  });
  expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
  expect(confirm.attributes['blockchain.tx.fee']).toBeUndefined();
}

describe('permissionless.js', () => {
  it('records the user operation of the docs setup, run as written', async () => {
    const before = await reader.getBalance({ address: RECIPIENT });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('./readme/permissionless.js');
    const [[hash]] = log.mock.calls as [[`0x${string}`]];
    log.mockRestore();

    expect(await reader.getBalance({ address: RECIPIENT })).toBe(before + parseEther('0.001'));
    // The bundle transaction, sent by the bundler to the EntryPoint, not by the smart account.
    expect((await reader.getTransaction({ hash })).to).toBe(entryPoint07Address.toLowerCase());
    expectUserOperationSpans(hash);
    expect(offline.unexpected).toEqual([]);
  });

  it('records no transaction or call batch of createSmartAccountClient with withHashspan() applied last', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const client = extendLast(
      createSmartAccountClient({
        account,
        client: reader,
        bundlerTransport: http(bundlerUrl),
        pollingInterval: 100,
      }),
      hashspan,
    );

    const sent = await client.sendTransaction({ to: RECIPIENT, value: 1n });
    const written = await client.writeContract({
      address: RECIPIENT,
      abi: TOKEN_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, 1n],
    });
    const { id } = await client.sendCalls({ calls: [{ to: RECIPIENT, value: 1n }] });
    expect(await hashspan.flush()).toBe(true);

    for (const hash of [sent, written]) {
      expect((await reader.getTransactionReceipt({ hash })).status).toBe('success');
    }
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(tracing.spans()).toEqual([]);

    // The bundler actions on the same client are traced.
    const userOpHash = await client.sendUserOperation({ calls: [{ to: RECIPIENT, value: 1n }] });
    const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
    expectUserOperationSpans(receipt.receipt.transactionHash);
  });

  it('needs a cast in TypeScript to extend createSmartAccountClient last', () => {
    const client = createSmartAccountClient({
      account,
      client: reader,
      bundlerTransport: http(bundlerUrl),
    });
    // @ts-expect-error viem's extend() types expect viem's own sendTransaction (docs/integrations.md).
    const extended = client.extend(withHashspan());
    expect(extended).toHaveProperty('sendUserOperation');
  });
});

describe('ZeroDev', () => {
  it('records no transaction of createKernelAccountClient with withHashspan() applied last', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const client = extendLast(
      createKernelAccountClient({
        // A Kernel account needs Kernel's contracts, which are not published as npm artifacts: ZeroDev's client runs
        // with the stand-in account.
        account: account as never,
        chain: foundry,
        client: reader,
        bundlerTransport: http(bundlerUrl),
        pollingInterval: 100,
        // ZeroDev's default asks its own bundler for `zd_getUserOperationGasPrice`.
        userOperation: { estimateFeesPerGas: async () => reader.estimateFeesPerGas() },
      }),
      hashspan,
    );

    const hash = await client.sendTransaction({ to: RECIPIENT, value: 1n });
    expect(await hashspan.flush()).toBe(true);

    expect((await reader.getTransactionReceipt({ hash })).status).toBe('success');
    expect(tracing.spans()).toEqual([]);

    const userOpHash = await client.sendUserOperation({ calls: [{ to: RECIPIENT, value: 1n }] });
    const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
    expectUserOperationSpans(receipt.receipt.transactionHash);
  });
});
