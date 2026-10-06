---
'@hashspan/core': minor
'@hashspan/viem': minor
---

Mark fees another account paid for the sender. `ReceiptLike` takes `sponsored: true` for a transaction whose fee was
paid by an account other than its sender, and the `blockchain.client.fee` sample then carries `blockchain.fee.payer`
`sponsor` (`BLOCKCHAIN_FEE_PAYER_VALUE_SPONSOR`), a new value of its closed set; a payment's settlement keeps
`facilitator`. No address is recorded.

`@hashspan/viem` sets it for a Tempo receipt (type `0x76`) whose `feePayer` is a valid address other than its `from`.
A sync send that returns a pending receipt, as a Tempo multisig relay does below quorum, no longer ends its confirm
span as `_OTHER`: the span waits for the submitted transaction's receipt off the caller's path, within a background
confirmation's `timeoutMs`, at most 60 receipt requests and the `maxBackgroundConfirmations` limit, and otherwise ends
as `timeout`. A receipt that names the awaited multisig operation under `multisig` is recorded for its hash. The
README notes that the actions of `tempoActions()` from `viem/tempo` are traced only when `withHashspan()` was applied
before it.
