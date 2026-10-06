---
'@hashspan/core': minor
'@hashspan/viem': minor
---

Mark fees another account paid for the sender, and treat a pending receipt as no outcome. `ReceiptLike` takes
`sponsored: true` for a transaction whose fee was paid by an account other than its sender, and the
`blockchain.client.fee` sample then carries `blockchain.fee.payer` `sponsor` (`BLOCKCHAIN_FEE_PAYER_VALUE_SPONSOR`), a
new value of its closed set; a payment's settlement keeps `facilitator`. No address is recorded. `ReceiptLike.status`
also takes `pending`: it withdraws the wait as a timeout does, and the confirm span ends without an outcome, error or
metric sample only when no other wait of the transaction is running.

`@hashspan/viem` sets `sponsored` for a Tempo receipt (type `0x76`) whose `feePayer` is a valid address other than its
`from`. A sync send that returns a pending receipt, as a Tempo multisig relay does below quorum, no longer ends its
confirm span as `_OTHER`: by default the span ends without an outcome, with no request added. The new
`followMultisigOperations` option (`true` or `{ timeoutMs }`, off by default) instead waits for the transaction the
relay submits for the operation, off the caller's path, with at most 60 receipt requests within its timeout (default
120 000 ms), as one of the `maxBackgroundConfirmations`. The README notes that the actions of `tempoActions()` from
`viem/tempo` are traced only when `withHashspan()` was applied before it.
