// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written with `hardhat run` in the Hardhat project of
// hardhat.int.test.ts, and docs.test.ts checks that the docs show the region unchanged.

// #region readme
import { withHashspan } from '@hashspan/viem';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise.
const sdk = new NodeSDK({ serviceName: 'counter-script' });
sdk.start();

const { viem } = await network.create();
const hashspan = withHashspan();
// hardhat-viem creates new clients for each helper: extend them, and pass them to every helper that sends.
const publicClient = (await viem.getPublicClient()).extend(hashspan);
const [sender] = await viem.getWalletClients();
if (sender === undefined) throw new Error('The network has no accounts');
const client = { public: publicClient, wallet: sender.extend(hashspan) };

// The deployment records a confirm span only: deployContract is not traced yet.
const counter = await viem.deployContract('Counter', [], { client });
const hash = await counter.write.incBy([5n]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`${hash} ${receipt.status}`);

// Before the script ends:
await hashspan.flush();
await sdk.shutdown();
// #endregion
