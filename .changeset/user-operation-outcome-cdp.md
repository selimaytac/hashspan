---
'@hashspan/cdp': patch
---

A `waitForUserOperation` that CDP reports `complete`, confirmed without a `reader` or without the bundle receipt
within `confirmTimeoutMs` (also when `flush()` gives up), now ends its confirm span with `error.type` `_OTHER`, since
the operation's outcome is unknown, following the core change for user operation receipts without a boolean
`success`. The span still records the bundle transaction's hash.
