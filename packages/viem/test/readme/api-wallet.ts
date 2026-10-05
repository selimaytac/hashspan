// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { createTxTracker } from '@hashspan/core';
import { withHashspan } from '@hashspan/viem';
import { context } from '@opentelemetry/api';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

declare const walletApi: { send(tx: unknown): Promise<{ transactionHash: `0x${string}` }> };
declare const tx: unknown;
declare const from: `0x${string}`;
declare const to: `0x${string}`;
declare const value: bigint;

// #region readme
const tracker = createTxTracker();
const hashspan = withHashspan({ tracker });
const reader = createPublicClient({ chain: baseSepolia, transport: http() });

const send = tracker.startSend({ chainId: baseSepolia.id, from, to, value });
let hash: `0x${string}`;
try {
  // The API call runs in the send span's context, so its HTTP span nests under the send span.
  ({ transactionHash: hash } = await context.with(send.context, () => walletApi.send(tx)));
  send.end({ hash });
} catch (error) {
  send.fail(error);
  throw error;
}
hashspan.watch(reader, { hash }); // linked to the send span
// #endregion
