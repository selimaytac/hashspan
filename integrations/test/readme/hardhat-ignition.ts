// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written with `hardhat run` in the Hardhat project of
// hardhat.int.test.ts, and docs.test.ts checks that the docs show the region unchanged.

// #region readme
import { withHashspan } from '@hashspan/viem';
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

const sdk = new NodeSDK({ serviceName: 'counter-ignition' });
sdk.start();

const CounterModule = buildModule('CounterModule', (m) => {
  const counter = m.contract('Counter');
  m.call(counter, 'incBy', [5n]);
  return { counter };
});

const { viem, ignition } = await network.create();
const hashspan = withHashspan();
const publicClient = (await viem.getPublicClient()).extend(hashspan);
const [sender] = await viem.getWalletClients();
if (sender === undefined) throw new Error('The network has no accounts');
const client = { public: publicClient, wallet: sender.extend(hashspan) };

// Ignition sends through the network connection's provider, not through a viem client: no spans.
const { counter } = await ignition.deploy(CounterModule);

// The contract Ignition returns sends with clients of its own: bind it to the extended ones.
const traced = await viem.getContractAt('Counter', counter.address, { client });
const hash = await traced.write.incBy([1n]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`${hash} ${receipt.status}`);

await hashspan.flush();
await sdk.shutdown();
// #endregion
