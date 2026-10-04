---
'@hashspan/core': patch
---

The tracker validates and bounds every value it records, also those a caller or an adapter passes to it (ADR 0025).
A call without a positive safe integer chain id, or a confirmation without a 32-byte hex hash, records no span; a
send hash that is not one is not recorded. A send records only well-formed addresses, values, nonces, function names
and selectors; a receipt's block number and gas used must be non-negative safe integers, and its gas price and L1 fee
non-negative integers, with `blockchain.tx.fee` omitted unless every part of it is known. `error.type` and
`exception.type` take an error's name only if it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters),
else `_OTHER`. Revert reasons are cut to 1024 characters, and sanitized messages and function arguments are cut
without splitting a hex value. At most 64 receipts of a call batch status and 64 transaction hashes of a call batch
send are read. `createTxTracker()` no longer throws for options it cannot read, and uses the default for a `linkTtlMs`
or `maxTrackedTransactions` that is not a positive number. Valid values are recorded as before.
