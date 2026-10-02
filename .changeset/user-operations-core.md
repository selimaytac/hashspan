---
'@hashspan/core': minor
---

User operations of ERC-4337 smart accounts (ADR 0021): `tracker.startUserOperationSend()` records handing an
operation to a bundler as a `send {chainId}` span with `blockchain.user_operation.hash`, `.sender`, `.entry_point`
and `.call_count`, and `tracker.startUserOperationConfirm()` joins its `confirm {chainId}` span, keyed by chain and
user operation hash apart from transactions, with `blockchain.user_operation.success`, `.gas.used`, `.gas.cost`,
`.nonce` and `.paymaster`, and the bundle transaction's `blockchain.tx.hash` and `blockchain.block.number`. A reverted
operation ends with `error.type` `reverted`; no `blockchain.tx.status` or bundle fee is recorded. The send,
confirmation and fee histograms record user operations with `blockchain.operation.subject` `user_operation`, and
the fee histogram records the operation's own cost. When the redaction hook fails, the user operation hash and
success flag are kept.
