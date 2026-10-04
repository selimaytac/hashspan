---
'@hashspan/viem': patch
---

A `timeoutMs` that is not a finite non-negative number (a bigint, a symbol, `NaN`) no longer leaves the confirm span
open: the default timeout applies, and a duration longer than a timer can wait is cut to that. A `decodeRevertReason`
option that cannot be read no longer makes `withHashspan()` throw.
