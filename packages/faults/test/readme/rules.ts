// Example from packages/faults/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region unchanged.
// test/proxy.test.ts checks the behaviour it describes. The declaration outside the region stands in for the
// reader's proxy.
import type { FaultProxy } from '@hashspan/faults';

declare const proxy: FaultProxy;

// #region readme
// Request 1 hangs, request 2 fails, request 3 and later reach the node.
proxy.set({
  eth_getTransactionReceipt: [
    { fault: { kind: 'hang' }, times: 1 },
    { fault: { kind: 'rpc-error', code: -32603 }, after: 1, times: 1 },
  ],
});

// No faults.
proxy.set({});
// #endregion
