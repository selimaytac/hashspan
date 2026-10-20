// Example from packages/faults/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region unchanged.
// test/quick-start.test.ts runs it as written, against a local stand-in for the node. The declaration outside the
// region stands in for the reader's own node.
const nodeUrl = process.env.FAULTS_QUICK_START_NODE ?? 'http://127.0.0.1:8545';

// #region readme
import { startFaultProxy } from '@hashspan/faults';
import { createPublicClient, http } from 'viem';

// In front of a local node, such as Anvil on http://127.0.0.1:8545.
const proxy = await startFaultProxy(nodeUrl);
const client = createPublicClient({ cacheTime: 0, transport: http(proxy.url, { retryCount: 0 }) });

// The second eth_blockNumber gets a rate limit; the others reach the node.
proxy.set({ eth_blockNumber: { fault: { kind: 'http', status: 429 }, after: 1, times: 1 } });
for (let i = 0; i < 3; i++) {
  await client.getBlockNumber().then(
    (block) => console.log('block', block),
    (error: Error) => console.log('failed', error.name), // HttpRequestError
  );
}
console.log(proxy.requests()); // { eth_blockNumber: 3 }

await proxy.stop();
// #endregion
