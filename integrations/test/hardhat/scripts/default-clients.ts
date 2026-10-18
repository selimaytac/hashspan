// The control of hardhat.int.test.ts: the steps of readme/hardhat-script.ts with hardhat-viem's own clients, that is
// without the `client` option. The helpers create clients of their own, so the extended ones see nothing. A span of
// the script's own shows that its export works, so no blockchain span means none was recorded.
import { withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

const sdk = new NodeSDK({ serviceName: 'counter-default-clients' });
sdk.start();

const { viem } = await network.create();
const hashspan = withHashspan();
(await viem.getWalletClients()).map((client) => client.extend(hashspan));

await trace.getTracer('control').startActiveSpan('deploy_counter', async (span) => {
  try {
    const counter = await viem.deployContract('Counter');
    const hash = await counter.write.incBy([5n]);
    const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
    console.log(`${hash} ${receipt.status}`);
  } finally {
    span.end();
  }
});

await hashspan.flush();
await sdk.shutdown();
