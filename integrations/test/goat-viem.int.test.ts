// The `viem()` setup of docs/integrations.md for GOAT, run against Anvil: a wallet client extended with hashspan,
// passed to `@goat-sdk/wallet-viem`, and GOAT's `send_token` and `approve_token_evm` tools invoked directly (no model). The test file is ESM,
// so this also covers the ESM entry of the GOAT packages. Nothing leaves localhost (see offline.ts, a setup file).
import { getTools } from '@goat-sdk/core';
import { viem } from '@goat-sdk/wallet-viem';
import { withHashspan } from '@hashspan/viem';
import {
  type Address,
  createPublicClient,
  createWalletClient,
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
import { offline } from './offline.js';

const chain = foundry;
const RECIPIENT = '0x00000000000000000000000000000000000000cc';
const SPENDER = '0x00000000000000000000000000000000000000dd';
// Anvil's first account, unlocked on the node, sets up the chain. The agent is a throwaway local account.
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const agent = privateKeyToAccount(generatePrivateKey());
type GoatClient = Parameters<typeof viem>[0];

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: chain.id,
});
const reader = createPublicClient({ chain, transport: http(RPC_URL) });
let tracing: TestTracing;
let token: Address;

beforeAll(async () => {
  tracing = setupTracing();

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

/** Sends a native transfer (`send_token`) and an ERC-20 approval (`approve_token_evm`) through GOAT's tools, as the docs set it up. */
async function runGoat(confirm: 'background' | 'default'): Promise<Hex[]> {
  const hashspan = withHashspan(
    confirm === 'background' ? { confirm: { mode: 'background' } } : {},
  );
  const walletClient = createWalletClient({
    account: agent,
    chain,
    transport: http(RPC_URL),
  }).extend(hashspan);
  // `@goat-sdk/wallet-viem` pins its own viem (2.23.4), whose client type a newer viem's client does not satisfy;
  // at runtime the client works as it is.
  const wallet = viem(walletClient as unknown as GoatClient, { enableSend: true });

  const tools = await getTools({ wallet });
  const send = tools.find((tool) => tool.name === 'send_token');
  expect(send).toBeDefined();

  const native = (await send?.execute({
    recipient: RECIPIENT,
    amountInBaseUnits: '1',
  })) as { hash: Hex; status: string };
  const approve = tools.find((tool) => tool.name === 'approve_token_evm');
  expect(approve).toBeDefined();
  const erc20 = (await approve?.execute({
    tokenAddress: token,
    spender: SPENDER,
    amount: '5',
  })) as { hash: Hex; status: string };
  expect([native.status, erc20.status]).toEqual(['success', 'success']);

  await hashspan.flush();
  expect(offline.unexpected).toEqual([]);
  return [native.hash, erc20.hash];
}

const hashesOf = (name: string) =>
  tracing
    .spans()
    .filter((span) => span.name === name)
    .map((span) => span.attributes['blockchain.tx.hash']);

describe('GOAT viem() wallet', () => {
  it('records a send and a confirm span per transaction with background confirmation', async () => {
    const hashes = await runGoat('background');
    expect(hashesOf(`send ${chain.id}`).sort()).toEqual([...hashes].sort());
    expect(hashesOf(`confirm ${chain.id}`).sort()).toEqual([...hashes].sort());
    for (const span of tracing.spans().filter((s) => s.name === `confirm ${chain.id}`))
      expect(span.attributes['blockchain.tx.status']).toBe('success');
  });

  it('records only the send spans without background confirmation', async () => {
    const hashes = await runGoat('default');
    expect(hashesOf(`send ${chain.id}`).sort()).toEqual([...hashes].sort());
    expect(hashesOf(`confirm ${chain.id}`)).toEqual([]);
  });
});
