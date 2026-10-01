// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

declare const walletApi: { send(tx: unknown): Promise<{ transactionHash: `0x${string}` }> };
declare const tx: unknown;

// #region readme
const hashspan = withHashspan();
const reader = createPublicClient({ chain: baseSepolia, transport: http() });

const { transactionHash } = await walletApi.send(tx); // not traced by hashspan
hashspan.watch(reader, { hash: transactionHash });
// #endregion
