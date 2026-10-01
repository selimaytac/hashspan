// Example from packages/core/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
type Hash = `0x${string}`;
declare const from: Hash;
declare const to: Hash;
declare const value: bigint;
declare function sendSomehow(): Promise<string>;
declare function waitSomehow(hash: string): Promise<{
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  l1Fee: bigint | undefined;
  transactionHash: Hash;
}>;

// #region readme
import { createTxTracker } from '@hashspan/core';

const tracker = createTxTracker({ agent: { name: 'treasury-bot' } });

// Inside your tool, where the agent framework's span is active:
const send = tracker.startSend({ chainId: 8453, from, to, value, functionName: 'transfer' });
let hash: string;
try {
  hash = await sendSomehow();
  send.end({ hash });
} catch (error) {
  send.fail(error);
  throw error;
}

// Later, wherever you wait for the receipt (or in a background watcher):
const confirm = tracker.startConfirm({ chainId: 8453, hash });
const receipt = await waitSomehow(hash);
confirm.end({
  status: receipt.status, // 'success' | 'reverted'
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed,
  effectiveGasPrice: receipt.effectiveGasPrice,
  l1Fee: receipt.l1Fee, // OP-stack chains
  // Hash of the mined transaction: if a replacement was mined, the receipt is attributed to it (ADR 0008).
  transactionHash: receipt.transactionHash,
});
// #endregion
