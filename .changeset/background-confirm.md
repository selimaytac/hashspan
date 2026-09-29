---
"@hashspan/viem": minor
---

Add `confirm: { mode: 'background' }` to `withHashspan()`: sent transactions are confirmed without an explicit wait
and without delaying the send. The background confirmation polls independently of the caller's own
`waitForTransactionReceipt`, whose options (timeout, `confirmations`) are left untouched.
