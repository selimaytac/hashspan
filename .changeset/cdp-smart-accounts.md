---
'@hashspan/cdp': minor
---

Smart accounts (ADR 0021): smart accounts from `createSmartAccount`, `getSmartAccount`, `getOrCreateSmartAccount`
and `updateSmartAccount` are wrapped in place. Their `sendUserOperation`, `transfer`, `swap`, `useSpendPermission`
and quote `execute()`, the same on network-scoped smart accounts, and `cdp.evm.sendUserOperation`,
`prepareAndSendUserOperation`, `createSpendPermission` and `revokeSpendPermission` record a user operation `send`
span with its hash, sender and number of calls. `waitForUserOperation` records a linked `confirm` span with the
bundle transaction's hash; with a reader, the operation's success, gas used, cost, nonce, paymaster and EntryPoint
come from the bundle receipt's `UserOperationEvent`. CDP's `failed` ends it with `error.type` `failed`, and the SDK's
`TimeoutError` as `timeout`. `CDP_NETWORK_CHAIN_IDS` gains `bnb`, the user operation name of BNB Smart Chain.
Requires `@hashspan/core` with user operations; with an older tracker, user operations are passed on untraced.
