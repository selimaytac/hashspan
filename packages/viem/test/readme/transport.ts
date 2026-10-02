// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { type Account, type Chain, createWalletClient, http } from 'viem';
import { traceTransport, withHashspan } from '@hashspan/viem';

declare const account: Account;
declare const chain: Chain;

// #region readme
const wallet = createWalletClient({
  account,
  chain,
  transport: traceTransport(http(), {
    methods: (method) => method !== 'eth_getTransactionReceipt',
  }),
}).extend(withHashspan());
// #endregion
