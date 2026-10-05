---
'@hashspan/viem': minor
---

`sendTransactionSync` and `writeContractSync` (viem 2.38.0 and later), which send a transaction and return its receipt
in one call, are now traced: each records a send span and a confirm span, as `sendTransaction` or `writeContract`
followed by `waitForTransactionReceipt` do, with the receipt's status, fees and revert reason. viem returns the hash
only with the receipt, so both spans cover the call. A call with `throwOnReceiptRevert` that rejects for a reverted
transaction is recorded as that reverted receipt, found by the own `name` of the error or one of its causes. The
receipt or error returned to the caller is unchanged. `sendRawTransactionSync` stays untraced, as
`sendRawTransaction` does.
