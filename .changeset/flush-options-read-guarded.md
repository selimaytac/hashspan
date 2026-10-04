---
'@hashspan/viem': patch
'@hashspan/cdp': patch
'@hashspan/x402': patch
---

`flush()` reads `timeoutMs` as an own data property and always resolves to a boolean. Options it cannot read (`null`,
a revoked Proxy, a getter or a Proxy trap that throws) made the viem and cdp `flush()` reject, and the x402 one
resolve `false` without waiting; they now use the default of 10 000 ms, as does a `timeoutMs` that is not a
non-negative number.
