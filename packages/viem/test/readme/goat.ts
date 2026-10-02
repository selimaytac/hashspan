// Example from docs/integrations.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the document shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { type Account, type Chain, createWalletClient, http, type WalletClient } from 'viem';
import { withHashspan } from '@hashspan/viem';

// Stands in for `viem()` of @goat-sdk/wallet-viem, which this repository does not depend on.
declare function viem(client: WalletClient): unknown;
declare const account: Account;
declare const chain: Chain;

// #region readme
// GOAT waits for receipts on a client it derives from this one: background confirmation records them.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const wallet = viem(createWalletClient({ account, chain, transport: http() }).extend(hashspan));
// #endregion
