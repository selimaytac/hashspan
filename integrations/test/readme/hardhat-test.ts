// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written with `hardhat test nodejs` in the Hardhat
// project of hardhat.int.test.ts, and docs.test.ts checks that the docs show the region unchanged. Its name does not
// end in `.test.ts`, so vitest does not collect it.

// #region readme
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { withHashspan } from '@hashspan/viem';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

// Hardhat runs the test files in its own process: start the SDK once, before the first test.
const sdk = new NodeSDK({ serviceName: 'counter-tests' });
sdk.start();

describe('Counter', async () => {
  const { viem } = await network.create();
  const hashspan = withHashspan();
  const publicClient = (await viem.getPublicClient()).extend(hashspan);
  const [sender] = await viem.getWalletClients();
  if (sender === undefined) throw new Error('The network has no accounts');
  const client = { public: publicClient, wallet: sender.extend(hashspan) };

  after(async () => {
    await hashspan.flush();
    await sdk.shutdown();
  });

  it('adds the increment', async () => {
    const counter = await viem.deployContract('Counter', [], { client });
    const hash = await counter.write.incBy([5n]);
    await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await counter.read.x(), 5n);
  });
});
// #endregion
