---
"@hashspan/viem": patch
"@hashspan/cdp": patch
---

Tracing no longer runs getters on call arguments. The adapters read the fields they record (such as `to`, `value`,
`network` or a transaction's fields) only from own data properties, so a getter with side effects, or one that
returns a different value per read, now sees the same reads as without tracing; a field behind a getter is left out
of the span. A `waitForTransactionReceipt` call whose `hash` or `onReplaced` is a getter is passed on untraced.
