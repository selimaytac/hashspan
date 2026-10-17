// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file against permissionless's types and runs it against Anvil
// (smart-account-sdks.int.test.ts), and docs.test.ts checks that the docs show the region unchanged. The import
// outside the region stands in for the reader's own smart account and bundler URL.
import { account, bundlerUrl } from '../smart-account-setup.js';

// #region readme
import { withHashspan } from '@hashspan/viem';
import { smartAccountActions } from 'permissionless';
import { createPublicClient, http, parseEther } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { foundry } from 'viem/chains';

// Start the OpenTelemetry SDK before this, as in the quick start.
const hashspan = withHashspan();
const client = createPublicClient({ chain: foundry, transport: http('http://127.0.0.1:8545') }); // Anvil

// The client createSmartAccountClient({ account, client, bundlerTransport }) builds, with hashspan applied before
// permissionless's actions, so that they send through the traced user operation actions.
const smartAccountClient = createBundlerClient({ account, client, transport: http(bundlerUrl) })
  .extend(hashspan)
  .extend(smartAccountActions);

// A user operation send span, and its confirm span as permissionless waits for the operation's receipt.
const hash = await smartAccountClient.sendTransaction({
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  value: parseEther('0.001'),
});
// `hash` is the bundle transaction's: a wait for it on a traced client would record the bundle, not the operation.
console.log(hash);

// Before a short-lived process exits, then shut the SDK down:
await hashspan.flush();
// #endregion
