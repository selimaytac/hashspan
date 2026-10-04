// The `ViemWalletProvider` setup of docs/integrations.md, run against Anvil: the provider's own methods and an
// ERC-20 action, with and without background confirmation. Nothing leaves localhost (see offline.ts, a setup file).
import { AgentKit, erc20ActionProvider, ViemWalletProvider } from '@coinbase/agentkit';
import { withHashspan } from '@hashspan/viem';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  parseEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { setupTracing, type TestTracing } from '../../packages/viem/test/tracing.js';
import { testUsdAbi, testUsdBytecode } from '../../packages/x402/test/token/test-usd.js';
import { multicall3Address, multicall3CreationCode } from './multicall3.js';
import { offline } from './offline.js';

// AgentKit's ERC-20 actions read token details with a multicall, so the chain names a Multicall3 contract.
const chain = defineChain({
  ...foundry,
  contracts: { multicall3: { address: multicall3Address } },
});
const RECIPIENT = '0x00000000000000000000000000000000000000cc';
const SPENDER = '0x00000000000000000000000000000000000000dd';
// Anvil's first account, unlocked on the node, sets up the chain. The agent is a throwaway local account.
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const agent = privateKeyToAccount(generatePrivateKey());
type ProviderClient = ConstructorParameters<typeof ViemWalletProvider>[0];

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: chain.id,
});
const reader = createPublicClient({ chain, transport: http(RPC_URL) });
let tracing: TestTracing;
let token: Address;

beforeAll(async () => {
  tracing = setupTracing();

  const runtime = await reader.call({ data: multicall3CreationCode });
  await reader.request({
    method: 'anvil_setCode' as never,
    params: [multicall3Address, runtime.data] as never,
  });
  const deployer = createWalletClient({ account: DEPLOYER, chain, transport: http(RPC_URL) });
  const deployment = await deployer.deployContract({ abi: testUsdAbi, bytecode: testUsdBytecode });
  token = (await reader.waitForTransactionReceipt({ hash: deployment })).contractAddress as Address;
  const mint = await deployer.writeContract({
    address: token,
    abi: testUsdAbi,
    functionName: 'mint',
    args: [agent.address, 1_000_000_000n],
  });
  await reader.waitForTransactionReceipt({ hash: mint });
  await reader.request({
    method: 'anvil_setBalance' as never,
    params: [agent.address, `0x${parseEther('10').toString(16)}`] as never,
  });
});

afterAll(async () => {
  await tracing?.teardown();
  await instance.stop();
});

beforeEach(() => tracing.exporter.reset());

/** Sends three transactions through the provider, as the docs describe it, and returns their hashes. */
async function runAgentKit(confirm: 'background' | 'default'): Promise<Hex[]> {
  const analytics = offline.analytics.length;
  // The docs setup: the provider waits for receipts on a public client of its own.
  const hashspan = withHashspan(
    confirm === 'background' ? { confirm: { mode: 'background' } } : {},
  );
  const walletClient = createWalletClient({
    account: agent,
    chain,
    transport: http(RPC_URL),
  }).extend(hashspan);
  // Without `rpcUrl` (or RPC_URL in the environment), the provider's public client uses the chain's default RPC.
  // AgentKit depends on an exact, older viem whose client type a newer viem's client does not satisfy, with or
  // without hashspan; at runtime the client works as it is.
  const walletProvider = new ViemWalletProvider(walletClient as unknown as ProviderClient, {
    rpcUrl: RPC_URL,
  });

  const sent = await walletProvider.sendTransaction({ to: RECIPIENT, value: 1n });
  await walletProvider.waitForTransactionReceipt(sent);
  const transferred = await walletProvider.nativeTransfer(RECIPIENT, '1');

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

  await hashspan.flush();
  // AgentKit reported the provider and the action to its analytics endpoint, and the stub answered.
  expect(offline.analytics.length).toBeGreaterThan(analytics);
  expect(offline.unexpected).toEqual([]);
  return [sent, transferred, approved];
}

const hashesOf = (name: string) =>
  tracing
    .spans()
    .filter((span) => span.name === name)
    .map((span) => span.attributes['blockchain.tx.hash']);

describe('AgentKit ViemWalletProvider', () => {
  it('records a send and a confirm span per transaction with background confirmation', async () => {
    const hashes = await runAgentKit('background');
    expect(hashesOf(`send ${chain.id}`).sort()).toEqual([...hashes].sort());
    expect(hashesOf(`confirm ${chain.id}`).sort()).toEqual([...hashes].sort());
    for (const span of tracing.spans().filter((s) => s.name === `confirm ${chain.id}`))
      expect(span.attributes['blockchain.tx.status']).toBe('success');
  });

  it('records only the send spans without background confirmation', async () => {
    const hashes = await runAgentKit('default');
    expect(hashesOf(`send ${chain.id}`).sort()).toEqual([...hashes].sort());
    expect(hashesOf(`confirm ${chain.id}`)).toEqual([]);
  });
});
