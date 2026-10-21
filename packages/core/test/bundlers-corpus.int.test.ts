// Checks the committed bundler corpus on a local Anvil with the chain setup of the matrix (scripts/bundlers/chain.mjs):
// chain id 1337, EntryPoint v0.7 and SimpleAccountFactory through the deterministic deployer. The senders the corpus
// was built for are the factory's, and the operations do on chain what the corpus says: the plain one lands through a
// direct handleOps from a well-known key, and the negatives fail validation with the AAxx code their rows name. No
// bundler runs here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, type Hex, http } from 'viem';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARTIFACTS_DIR,
  chainOf,
  chainOperation,
  senderOnChain,
  setupChain,
} from '../../../scripts/bundlers/chain.mjs';
import {
  ACCOUNTS,
  CHAIN_ID,
  CORPUS_FILE,
  ENTRY_POINTS,
  FACTORY,
  fundedSalts,
  SENDERS,
  saltsOf,
} from '../../../scripts/bundlers/corpus.mjs';
import { startAnvil } from '../../viem/test/start-anvil.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, CORPUS_FILE), 'utf8'));
const artifactsDir = join(root, ARTIFACTS_DIR);

if (!existsSync(artifactsDir)) {
  throw new Error('the EntryPoint artifacts are not installed: run ./scripts/install-bundler.sh');
}

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: CHAIN_ID,
});
const chain = chainOf(rpcUrl);
const reader = createPublicClient({ chain, transport: http(rpcUrl) });
const direct = createWalletClient({
  account: privateKeyToAccount(ACCOUNTS.direct as Hex),
  chain,
  transport: http(rpcUrl),
});

beforeAll(async () => {
  await setupChain(rpcUrl, { artifactsDir, fundedSalts: fundedSalts() });
});
afterAll(async () => {
  await instance.stop();
});

type Built = {
  id: string;
  ops: Record<string, { hash: Hex; userOperation: Record<string, Hex> }>;
};
const opOf = (id: string, name = 'main') =>
  (corpus.cases as Built[]).find((c) => c.id === id)?.ops[name] as Built['ops'][string];

/** The packed form handleOps takes, from a committed operation. */
const packed = (rpc: Record<string, Hex>) =>
  toPackedUserOperation({
    sender: rpc.sender as Hex,
    nonce: BigInt(rpc.nonce as Hex),
    factory: rpc.factory,
    factoryData: rpc.factoryData,
    callData: rpc.callData as Hex,
    callGasLimit: BigInt(rpc.callGasLimit as Hex),
    verificationGasLimit: BigInt(rpc.verificationGasLimit as Hex),
    preVerificationGas: BigInt(rpc.preVerificationGas as Hex),
    maxFeePerGas: BigInt(rpc.maxFeePerGas as Hex),
    maxPriorityFeePerGas: BigInt(rpc.maxPriorityFeePerGas as Hex),
    signature: rpc.signature as Hex,
  });

/** Simulates a direct handleOps of one committed operation; resolves, or rejects with the EntryPoint's error. */
const simulate = (rpc: Record<string, Hex>) =>
  reader.simulateContract({
    account: direct.account,
    address: ENTRY_POINTS['0.7'],
    abi: entryPoint07Abi,
    functionName: 'handleOps',
    args: [[packed(rpc)], direct.account.address],
  });

describe('bundler corpus on Anvil', () => {
  it('has the factory and every sender where the corpus was built for them', async () => {
    expect(await reader.getChainId()).toBe(CHAIN_ID);
    expect(corpus.factory).toBe(FACTORY);
    const onChain: Record<number, string> = {};
    for (const salt of saltsOf()) onChain[salt] = await senderOnChain(rpcUrl, salt);
    expect(onChain).toEqual(SENDERS);
  });

  it('lands the plain operation through a direct handleOps from a well-known key', async () => {
    const op = opOf('plain-op');
    const hash = await direct.writeContract({
      address: ENTRY_POINTS['0.7'],
      abi: entryPoint07Abi,
      functionName: 'handleOps',
      args: [[packed(op.userOperation)], direct.account.address],
    });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const events = await chainOperation(rpcUrl, op.hash);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ transactionHash: hash, success: true });
    expect(events[0]?.sender).toBe(op.userOperation.sender);
  });

  it.each([
    ['bad-signature', 'AA24'],
    ['validation-revert', 'AA23'],
    ['insufficient-prefund', 'AA21'],
    ['nonce-gap', 'AA25'],
  ])('fails %s in validation with %s', async (id, code) => {
    await expect(simulate(opOf(id).userOperation)).rejects.toThrow(code);
  });

  it('reverts the call of the execution-revert case without failing validation', async () => {
    const op = opOf('execution-revert');
    await expect(simulate(op.userOperation)).resolves.toBeDefined();
  });
});
