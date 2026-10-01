---
"@hashspan/cdp": patch
---

`flush()` now also waits for the confirm span of a `waitForTransactionReceipt` on a network-scoped account without a
reader, and ends it as `timeout` if it cannot wait longer. Before, `flush()` could return while that span was still
open, so a short-lived process could exit without exporting it.
