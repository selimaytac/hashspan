---
'@hashspan/cdp': patch
---

A confirm span of a network-scoped `waitForTransactionReceipt` or of `waitForUserOperation` now ends when the wait's
result or error cannot be read (a Proxy whose traps throw, an error whose `name` getter throws), as a failure with
`error.type` `_OTHER`; before, it could stay open while `flush()` reported success. The error's name is read from an
own data property.
