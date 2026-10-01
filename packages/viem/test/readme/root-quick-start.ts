// Example from README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { Account, Address } from 'viem';

declare const account: Account;
declare const to: Address;
declare const value: bigint;

// #region readme
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() }).extend(hashspan);
const reader = createPublicClient({ chain: baseSepolia, transport: http() }).extend(hashspan);

// Inside an agent tool: send + confirm spans appear under the tool span.
const hash = await wallet.sendTransaction({ to, value });
await reader.waitForTransactionReceipt({ hash });
// #endregion
