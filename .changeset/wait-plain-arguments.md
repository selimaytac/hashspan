---
'@hashspan/viem': patch
---

`waitForTransactionReceipt` passes arguments that are not a plain object, such as a class instance, on to viem as they
are: the wait is traced, but a replacement is not attributed, as in the cdp adapter. Only plain objects get the
replacement callback.
