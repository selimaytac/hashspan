---
'@hashspan/cdp': patch
---

`confirmTimeoutMs` now bounds each bundle receipt request of a completed user operation, not only the time between
requests: a reader whose request never answers no longer keeps the confirm span open past it, a receipt that arrives
later is not used, and once `flush()` gives up the work it awaits settles, so the next `flush()` reports success. A
`confirmTimeoutMs` that is not a finite non-negative number falls back to the default for this wait.
