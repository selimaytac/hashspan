// Example from packages/faults/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region unchanged.
// test/quick-start.test.ts runs it as written, against a local stand-in for the node. The declaration outside the
// region stands in for the reader's own node.
const nodeUrl = process.env.FAULTS_QUICK_START_NODE ?? 'http://127.0.0.1:8545';

// #region readme
import { startFaultProxy } from '@hashspan/faults';

// In front of a local node, such as Anvil on http://127.0.0.1:8545.
const proxy = await startFaultProxy(nodeUrl);

// The second eth_blockNumber gets a rate limit; the others reach the node.
proxy.set({ eth_blockNumber: { fault: { kind: 'http', status: 429 }, after: 1, times: 1 } });
for (let id = 1; id <= 3; id++) {
  const response = await fetch(proxy.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_blockNumber', params: [] }),
  });
  console.log(response.status, await response.text()); // 200 {"jsonrpc":"2.0","id":1,"result":"0x..."}, 429 ...
}
console.log(proxy.requests()); // { eth_blockNumber: 3 }

await proxy.stop();
// #endregion
