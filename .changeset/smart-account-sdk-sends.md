---
'@hashspan/viem': patch
---

A smart account SDK's `sendTransaction`, `writeContract` and `sendCalls` (permissionless.js `createSmartAccountClient`, ZeroDev `createKernelAccountClient`) are no longer recorded as a transaction of the bundle, with the bundler's status and fee, or as a call batch, when `withHashspan()` is applied to the finished client: a send whose account is a smart account is called untraced, with a `diag` warning (#430). `sendUserOperation` and `waitForUserOperationReceipt` on such a client stay traced, and applying `withHashspan()` before the SDK's actions records the user operations of those sends; docs/integrations.md shows the permissionless setup.
