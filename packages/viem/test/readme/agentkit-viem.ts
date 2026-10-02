// Example from docs/integrations.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the document shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { type Account, type Chain, createWalletClient, http, type WalletClient } from 'viem';
import { withHashspan } from '@hashspan/viem';

// Stands in for `ViemWalletProvider` of @coinbase/agentkit, which this repository does not depend on.
declare class ViemWalletProvider {
  constructor(walletClient: WalletClient);
}
declare const account: Account;
declare const chain: Chain;

// #region readme
// The provider waits for receipts on a client of its own: background confirmation records them.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const walletClient = createWalletClient({ account, chain, transport: http() }).extend(hashspan);
const walletProvider = new ViemWalletProvider(walletClient);

// Before a short-lived process exits:
await hashspan.flush();
// #endregion
