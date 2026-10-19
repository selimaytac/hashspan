// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, user-operation.int.test.ts runs it against Anvil, and docs.test.ts checks that
// the README shows the region unchanged. The import outside the region stands in for the reader's own values.
import {
  bundler,
  chain,
  hash,
  rpcUrl,
  smartAccountAddress,
  userOpHash,
} from '../watch-user-operation-setup.js';

// #region readme
import { createPublicClient, http } from 'viem';
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();
const reader = createPublicClient({ chain, transport: http(rpcUrl) });

// The bundle transaction's hash a wallet or an SDK returned, and the smart account that sent the operation:
hashspan.watchUserOperation(reader, { bundleHash: hash, sender: smartAccountAddress });

// Or the user operation hash, through a bundler client (createBundlerClient):
hashspan.watchUserOperation(bundler, { userOpHash });

// Before a short-lived process exits:
await hashspan.flush();
// #endregion
