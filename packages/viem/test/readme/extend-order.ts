// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { type Account, type Chain, createWalletClient, http, publicActions } from 'viem';
import { withHashspan } from '@hashspan/viem';

declare const account: Account;
declare const chain: Chain;
const walletClient = createWalletClient({ account, chain, transport: http() });

// #region readme
// Traced
walletClient.extend(publicActions).extend(withHashspan());
// Not traced: publicActions replaces waitForTransactionReceipt
walletClient.extend(withHashspan()).extend(publicActions);
// #endregion
