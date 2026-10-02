---
'@hashspan/viem': patch
---

`traceTransport()` reads a request's method without running a getter: a method behind an accessor, or arguments whose
property cannot be read (a Proxy trap that throws), are sent untraced, unchanged.
