---
'@hashspan/core': minor
'@hashspan/viem': minor
'@hashspan/cdp': minor
---

Record how many confirmations a wait asked for as `blockchain.tx.wait.confirmations` (int) on a transaction's
confirm span, from the wait that ended the span: the one whose receipt ended it, or the last to time out or fail. It
is a span attribute only, never a metric attribute. `ConfirmInput` takes it as `confirmations`, recorded only when it
is a positive safe integer and read from an own data property, and `ATTR_BLOCKCHAIN_TX_WAIT_CONFIRMATIONS` names the
attribute. A tracker from an older core ignores the field, and the attribute is then absent.

`@hashspan/viem` passes the count as viem applies it: `confirmations` of `waitForTransactionReceipt` when it is a
positive safe integer, 1 when it is omitted, `0`, negative or `NaN`, and nothing for any other value or one behind an
accessor. Background confirmation and `watch()` record 1, so with background confirmation on, the background wait
usually ends the span first and records 1. Sync actions, user operations and call batches record nothing.
`@hashspan/cdp` records the same for a network-scoped `waitForTransactionReceipt` without a reader, and 1 for its
`{ transactionHash }` form; with a reader, and for `@hashspan/x402` settlements, the confirmation through `watch()`
records 1. No request is added.
