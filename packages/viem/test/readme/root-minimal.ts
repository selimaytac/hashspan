// Example from README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { Account, Address } from 'viem';

declare const account: Account;
declare const to: Address;
declare const value: bigint;

// #region readme
import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: base, transport: http() }).extend(hashspan);
const reader = createPublicClient({ chain: base, transport: http() }).extend(hashspan);

// In your agent's tool call or your request handler: the spans join its trace.
const hash = await wallet.sendTransaction({ to, value }); // send span
await reader.waitForTransactionReceipt({ hash }); // confirm span

await hashspan.flush(); // before the process exits
// #endregion
