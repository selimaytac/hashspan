// Example from docs/migrating-to-1.0.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the page shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { createTxTracker, type ReceiptLike } from '@hashspan/core';

type Hash = `0x${string}`;
declare const from: Hash;
declare const to: Hash;
declare const value: bigint;
declare const hash: Hash;
declare const receipt: ReceiptLike;
declare const startTime: Date;
declare const endTime: Date;
const tracker = createTxTracker();

// #region readme
const send = tracker.startSend({ chainId: 8453, from, to, value, startTime });
send.end({ hash }, { endTime });

const confirm = tracker.startConfirm({ chainId: 8453, hash, startTime });
confirm.end(receipt, { endTime });
// #endregion
