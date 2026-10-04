# Upstream findings

Bugs in the libraries and tools hashspan builds on, found while building and testing hashspan, reported to their
projects and fixed there. Only issues that are fixed or confirmed upstream are listed. Each entry says what hashspan
does about it: a workaround stays while the supported range of the library still includes an affected release.

## viem

`@hashspan/viem` supports viem `^2.21.0` (its peer dependency), so a workaround can go once that floor is at or
above the release with the fix.

| Finding | Reported | Fixed | In hashspan |
|---|---|---|---|
| `waitForTransactionReceipt`: concurrent waits for the same hash on one client all ran with the first call's options (`timeout`, `confirmations`) | [wevm/viem#5137](https://github.com/wevm/viem/issues/5137), 2026-09-27 | [#5142](https://github.com/wevm/viem/pull/5142), viem 2.57.0 | Background confirmation waits through a copy of the client with its own `uid`, so it never joins the caller's wait ([confirmation.ts](../packages/viem/src/confirm/confirmation.ts)) |
| `waitForTransactionReceipt` took the awaited transaction for its own replacement when the node returned it before its receipt, and failed the wait | [wevm/viem#5161](https://github.com/wevm/viem/issues/5161), 2026-09-30 | [#5179](https://github.com/wevm/viem/pull/5179), viem 2.57.3 | Background confirmation waits again after these errors, until its timeout (`isReceiptLag` in [receipt.ts](../packages/viem/src/confirm/receipt.ts)) |
| `waitForUserOperationReceipt` never resolved on a later call for a hash after concurrent waits for it had settled | [wevm/viem#5175](https://github.com/wevm/viem/issues/5175), 2026-10-02 | [#5176](https://github.com/wevm/viem/pull/5176), viem 2.57.3 | No change in the adapter; one unit test waits through separate clients ([user-operation.test.ts](../packages/viem/test/user-operation.test.ts)) |
| `sendCalls` with `experimental_fallback` did not fall back to plain transactions on Base's public RPC, which answers `wallet_sendCalls` with error -32604 | [wevm/viem#5178](https://github.com/wevm/viem/issues/5178), 2026-10-03 | [#5180](https://github.com/wevm/viem/pull/5180), viem 2.57.3 | No workaround |
