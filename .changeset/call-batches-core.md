---
'@hashspan/core': minor
---

Call batches of EIP-5792 `wallet_sendCalls` (ADR 0022): `tracker.startCallBatchSend()` records handing a batch to a
wallet as a `send {chainId}` span with `blockchain.call_batch.id`, `.sender` and `.call_count`, and
`tracker.startCallBatchConfirm()` joins its `confirm {chainId}` span, keyed by chain and batch id apart from
transactions and user operations, with `blockchain.call_batch.status` (`success`, `reverted`,
`partially_reverted` for codes 200, 500, 600), `.status_code`, `.atomic` and `.transaction_hashes`. Code 400 ends
with `error.type` `failed`, any other code with `_OTHER`, and a pending result without an outcome; no fee is
recorded. Batch ids must be `0x`-prefixed hex. Transactions an account sent itself for a batch are linked to its send
span. Metrics of batches carry `blockchain.operation.subject` `call_batch` and the batch status, never raw codes.
