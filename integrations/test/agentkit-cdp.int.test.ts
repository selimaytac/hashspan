// The `CdpEvmWalletProvider` and `CdpSmartWalletProvider` setups of docs/integrations.md, run against the local
// stand-in for the CDP API (packages/cdp/test/mock-cdp-api.ts) and Anvil: the providers' own send and wait methods
// and an ERC-20 action, with their CdpClient wrapped by @hashspan/cdp. Nothing leaves localhost (see offline.ts).
//
// `configureWithWallet()` is not run: it builds its CdpClient from the three credentials only, its config in AgentKit
// 0.10.4 has no field for the client's `basePath` option, and the CDP SDK reads no environment variable for the API's
// base URL. The providers are built with the constructor `configureWithWallet()` ends with (private in the type
// declarations only, see dist/wallet-providers/cdpEvmWalletProvider.js and cdpSmartWalletProvider.js), around a client
// created with `basePath`, pointed at the stand-in.
// Never call `configureWithWallet()` or `new CdpClient()` without `basePath` here: every CdpClient reconfigures one
// HTTP client shared by the SDK, so the requests of all clients would go to the real API, which offline.ts, a fetch
// stub, does not see.
import {
  AgentKit,
  CdpEvmWalletProvider,
  CdpSmartWalletProvider,
  erc20ActionProvider,
} from '@coinbase/agentkit';
import { CdpClient } from '@coinbase/cdp-sdk';
import { withHashspan } from '@hashspan/cdp';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, type Hex, http } from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockCdpApi, throwawayCredentials } from '../../packages/cdp/test/mock-cdp-api.js';
import {
  testAccountCode,
  testEntryPointCode,
} from '../../packages/viem/test/entry-point/test-entry-point.js';
import { setupTracing, type TestTracing } from '../../packages/viem/test/tracing.js';
import { testUsdAbi, testUsdBytecode } from '../../packages/x402/test/token/test-usd.js';
import { multicall3CreationCode } from './multicall3.js';
import { offline } from './offline.js';

const PORT = 18605;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const SMART_ACCOUNT = '0x00000000000000000000000000000000000A11cE' as const;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const SPENDER = '0x00000000000000000000000000000000000000dd' as const;
// The provider's network, as `configureWithWallet()` derives it from NETWORK_ID.
const network = { protocolFamily: 'evm', networkId: 'base-sepolia', chainId: '84532' };

// Keep the CDP SDK's usage tracking and error reporting off, as in the cdp package's tests.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';

// Anvil with Base Sepolia's chain id, so the real CDP network name applies; on `base`, the SDK would default the
// paymaster to CDP's node.
const instance = Instance.anvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: baseSepolia.id,
});
// The provider's public client, as `configureWithWallet({ rpcUrl })` creates it. Base Sepolia names Multicall3 at
// its usual address, which the ERC-20 actions read token details with.
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
  pollingInterval: 50,
});

let api: Awaited<ReturnType<typeof startMockCdpApi>>;
let tracing: TestTracing;
let token: Address;

beforeAll(async () => {
  await instance.start();
  tracing = setupTracing();
  const setCode = (address: Address, code: Hex) =>
    publicClient.request({ method: 'anvil_setCode' as never, params: [address, code] as never });
  const multicall3 = await publicClient.call({ data: multicall3CreationCode });
  await setCode(baseSepolia.contracts.multicall3.address, multicall3.data as Hex);
  await setCode(entryPoint07Address, testEntryPointCode);
  await setCode(SMART_ACCOUNT, testAccountCode);
  await publicClient.request({
    method: 'anvil_setBalance' as never,
    params: [SMART_ACCOUNT, '0xde0b6b3a7640000'] as never,
  });
  // Anvil's first account is the server account the stand-in sends from; the second sends the bundles.
  const [owner, bundler] = (await createWalletClient({
    transport: http(RPC_URL),
  }).getAddresses()) as [Address, Address];
  const deployer = createWalletClient({
    account: owner,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });
  const deployment = await deployer.deployContract({ abi: testUsdAbi, bytecode: testUsdBytecode });
  token = (await publicClient.waitForTransactionReceipt({ hash: deployment }))
    .contractAddress as Address;
  api = await startMockCdpApi({
    rpcUrl: RPC_URL,
    account: owner,
    smartAccount: SMART_ACCOUNT,
    bundler,
  });
});

afterAll(async () => {
  await tracing?.teardown();
  await api?.close();
  await instance.stop();
});

beforeEach(() => tracing.exporter.reset());

/** A CdpClient pointed at the stand-in, as `configureWithWallet()` would create it for the real API. */
const cdpClient = () => new CdpClient({ ...throwawayCredentials(), basePath: api.basePath });

/** The provider `configureWithWallet()` returns, built from what it would have created. */
async function evmWalletProvider(): Promise<CdpEvmWalletProvider> {
  const cdp = cdpClient();
  const serverAccount = await cdp.evm.createAccount();
  const Provider = CdpEvmWalletProvider as unknown as new (config: object) => CdpEvmWalletProvider;
  const provider = new Provider({ publicClient, cdp, serverAccount, network });
  // Fails loudly if a newer AgentKit changes what its constructor takes.
  expect(provider.getClient()).toBe(cdp);
  expect(provider.getAddress()).toBe(serverAccount.address);
  expect(provider.getNetwork().chainId).toBe('84532');
  return provider;
}

async function smartWalletProvider(): Promise<CdpSmartWalletProvider> {
  const cdp = cdpClient();
  const ownerAccount = await cdp.evm.createAccount();
  const smartAccount = await cdp.evm.createSmartAccount({ owner: ownerAccount });
  const Provider = CdpSmartWalletProvider as unknown as new (
    config: object,
  ) => CdpSmartWalletProvider;
  const provider = new Provider({
    publicClient,
    cdp,
    smartAccount,
    ownerAccount,
    network,
    paymasterUrl: undefined,
  });
  expect(provider.getClient()).toBe(cdp);
  expect(provider.getAddress()).toBe(SMART_ACCOUNT);
  expect(provider.getNetwork().chainId).toBe('84532');
  return provider;
}

const spansNamed = (name: string) => tracing.spans().filter((span) => span.name === name);
const sends = () => api.requests.filter((request) => request.endsWith('/send/transaction')).length;

describe('AgentKit CdpEvmWalletProvider', () => {
  it('records a send and a confirm span per transaction, from the provider and an action', async () => {
    const walletProvider = await evmWalletProvider();
    // The docs setup: wrap the provider's CdpClient, with its public client as the reader.
    const hashspan = withHashspan(walletProvider.getClient(), {
      reader: walletProvider.getPublicClient() as never,
    });
    const sendsBefore = sends();

    const sent = (await walletProvider.sendTransaction({ to: RECIPIENT, value: 1n })) as Hex;
    await walletProvider.waitForTransactionReceipt(sent);
    const transferred = (await walletProvider.nativeTransfer(RECIPIENT, '2')) as Hex;
    const agentKit = await AgentKit.from({
      walletProvider,
      actionProviders: [erc20ActionProvider()],
    });
    const approve = agentKit
      .getActions()
      .find((action) => action.name === 'ERC20ActionProvider_approve');
    const result = await approve?.invoke({
      amount: '1',
      tokenAddress: token,
      spenderAddress: SPENDER,
    });
    // Actions report failures in their result rather than by throwing.
    expect(result).toMatch(/^Approved 1 Test USD/);
    const approved = result?.match(/Transaction hash: (0x[0-9a-f]{64})/)?.[1] as Hex;
    await expect(hashspan.flush()).resolves.toBe(true);

    // Every send went through the stand-in, and nothing else left localhost.
    expect(sends() - sendsBefore).toBe(3);
    expect(offline.unexpected).toEqual([]);
    const hashes = [sent, transferred, approved].sort();
    const sendSpans = spansNamed('send 84532');
    expect(sendSpans.map((span) => span.attributes['blockchain.tx.hash']).sort()).toEqual(hashes);
    for (const span of sendSpans)
      expect(span.attributes['blockchain.tx.from']).toBe(walletProvider.getAddress().toLowerCase());
    const confirmSpans = spansNamed('confirm 84532');
    expect(confirmSpans.map((span) => span.attributes['blockchain.tx.hash']).sort()).toEqual(
      hashes,
    );
    for (const span of confirmSpans) {
      expect(span.attributes['blockchain.tx.status']).toBe('success');
      const send = sendSpans.find(
        (s) => s.attributes['blockchain.tx.hash'] === span.attributes['blockchain.tx.hash'],
      );
      expect(span.links[0]?.context.spanId).toBe(send?.spanContext().spanId);
    }
  });
});

describe('AgentKit CdpSmartWalletProvider', () => {
  it('records a send and a confirm span per user operation', async () => {
    const walletProvider = await smartWalletProvider();
    const hashspan = withHashspan(walletProvider.getClient(), {
      reader: walletProvider.getPublicClient() as never,
    });

    const userOpHash = (await walletProvider.sendTransaction({ to: RECIPIENT, value: 3n })) as Hex;
    const receipt = await walletProvider.waitForTransactionReceipt(userOpHash);
    expect(receipt.status).toBe('complete');
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(offline.unexpected).toEqual([]);
    const send = tracing.spanNamed('send 84532');
    expect(send.attributes).toMatchObject({
      'blockchain.user_operation.hash': userOpHash,
      'blockchain.user_operation.sender': SMART_ACCOUNT.toLowerCase(),
      'blockchain.user_operation.call_count': 1,
    });
    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.user_operation.hash': userOpHash,
      'blockchain.user_operation.success': true,
      'blockchain.user_operation.entry_point': entryPoint07Address.toLowerCase(),
      'blockchain.tx.hash': receipt.transactionHash,
    });
  });
});
