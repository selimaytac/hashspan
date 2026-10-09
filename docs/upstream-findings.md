# Upstream findings

Bugs and gaps in the libraries and tools hashspan builds on, found while building and testing hashspan, reported to their
projects and fixed there. Only issues that are fixed or confirmed upstream are listed.

There is one section per project, each with the same columns: the upstream issue, the pull request that fixed it, the
release with the fix, what hashspan does about it, and when that can go. A workaround stays while the supported range
of the library still includes an affected release.

## viem

`@hashspan/viem` supports viem `^2.21.0` (its peer dependency).

| Finding | Issue | Fix | Released in | In hashspan | Can go when |
|---|---|---|---|---|---|
| `waitForTransactionReceipt`: concurrent waits for the same hash on one client all ran with the first call's options (`timeout`, `confirmations`) | [wevm/viem#5137](https://github.com/wevm/viem/issues/5137) | [#5142](https://github.com/wevm/viem/pull/5142) | 2.57.0 | Background confirmation waits through a copy of the client with its own `uid`, so it never joins the caller's wait ([confirmation.ts](../packages/viem/src/confirm/confirmation.ts)) | The viem floor is 2.57.0 or later |
| `waitForTransactionReceipt` took the awaited transaction for its own replacement when the node returned it before its receipt, and failed the wait | [wevm/viem#5161](https://github.com/wevm/viem/issues/5161) | [#5179](https://github.com/wevm/viem/pull/5179) | 2.57.3 | Background confirmation waits again after these errors, until its timeout (`isReceiptLag` in [receipt.ts](../packages/viem/src/confirm/receipt.ts)) | The viem floor is 2.57.3 or later |
| `waitForUserOperationReceipt` never resolved on a later call for a hash after concurrent waits for it had settled | [wevm/viem#5175](https://github.com/wevm/viem/issues/5175) | [#5176](https://github.com/wevm/viem/pull/5176) | 2.57.3 | No change in the adapter; one unit test waits through separate clients ([user-operation.test.ts](../packages/viem/test/user-operation.test.ts)) | The tests run only on viem 2.57.3 or later |
| `sendCalls` with `experimental_fallback` did not fall back to plain transactions on Base's public RPC, which answers `wallet_sendCalls` with error -32604 | [wevm/viem#5178](https://github.com/wevm/viem/issues/5178) | [#5180](https://github.com/wevm/viem/pull/5180) | 2.57.3 | No workaround | Nothing to remove |

## Foundry (Anvil)

hashspan's integration tests run Anvil from Foundry, pinned in [install-anvil.sh](../scripts/install-anvil.sh).

| Finding | Issue | Fix | Released in | In hashspan | Can go when |
|---|---|---|---|---|---|
| Concurrent `eth_sendTransaction` calls from one unlocked account got the same nonce | [foundry-rs/foundry#17354](https://github.com/foundry-rs/foundry/issues/17354) | [#17356](https://github.com/foundry-rs/foundry/pull/17356) | nightly builds after 1.8.5; no stable release yet | The parallel agents test sends from one account per tool call ([parallel-agents.int.test.ts](../examples/ai-sdk-agent/test/parallel-agents.int.test.ts)) | The Anvil pin is a release with the fix |
| `anvil --celo` did not accept CIP-64 (`0x7b`) fee currency transactions, and `eth_fillTransaction` dropped `feeCurrency` | [foundry-rs/foundry#17462](https://github.com/foundry-rs/foundry/issues/17462) | [#17481](https://github.com/foundry-rs/foundry/pull/17481) (fee charged in the native currency) | nightly builds after 1.8.5; no stable release yet | The Celo fee currency path is tested with mocked receipts only ([fee-models.test.ts](../packages/viem/test/fee-models.test.ts)) | Nothing to remove; with the fix in the Anvil pin, the path can also be tested on Anvil |
