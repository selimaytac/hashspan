---
'@hashspan/core': minor
---

Call batches of EIP-5792 `wallet_sendCalls` (ADR 0022): `tracker.startCallBatchSend()` records handing a batch to a
wallet as a `send {chainId}` span with `blockchain.call_batch.id`, `.sender` and `.call_count`, and
`tracker.startCallBatchConfirm()` joins its `confirm {chainId}` span, keyed by chain and batch id apart from
transactions and user operations, with `blockchain.call_batch.status_code`, `.atomic` and `.transaction_hashes`.
Status 4xx, 5xx and 6xx end with `error.type` `failed`, `reverted` and `partially_reverted`; no fee is recorded.
Transactions an account sent itself for a batch are linked to its send span. Metrics of batches carry
`blockchain.operation.subject` `call_batch`.
