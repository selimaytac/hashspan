---
'@hashspan/core': patch
---

The send and confirmation histograms keep `error.type` only when it is an error class name of letters or a
lower-case code (such as `timeout` or an adapter's error code); any other value, such as a custom error name with an
identifier or an address in it, is recorded as `_OTHER`, so metric labels stay low-cardinality and free of
addresses. Spans keep their own `error.type`.
