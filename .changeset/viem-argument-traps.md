---
'@hashspan/viem': patch
---

A call whose arguments throw when telemetry reads them, such as a Proxy whose `getOwnPropertyDescriptor` or
`ownKeys` trap throws, or a revoked Proxy, is now made untraced with its original arguments instead of rejecting.
The base action runs once, and its result or error reaches the caller unchanged.
