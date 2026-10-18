---
"@hashspan/viem": patch
---

`createSmartAccountClient(...).extend(withHashspan())` on a permissionless.js smart account client type-checks without
a cast. The extension's return type leaves out an action whose type the client's `extend()` does not accept from an
extension, such as the SDK's own `sendTransaction`, so the extended client keeps the SDK's types for it. The types for
viem's own clients are unchanged.
