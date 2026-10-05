---
'@hashspan/core': patch
'@hashspan/viem': patch
'@hashspan/cdp': patch
'@hashspan/x402': patch
---

More bounds on what telemetry reads:

- A sanitized error message scans at most the first 4096 characters of its first line for URLs and hex values (a hex
  value cut there is still recorded as without the cut); text past that bound is not recorded, and the recorded
  message is cut to 256 characters as before. A URL cut at that bound before its path is recorded as `<url>`.
- `waitForTransactionReceipt` in `@hashspan/viem`, and the wait of a network-scoped account in `@hashspan/cdp`, read at
  most 64 objects of the arguments' prototype chain when they look up `onReplaced`; arguments with a longer chain are
  passed on untraced and unchanged, as arguments that cannot be read are.
- `@hashspan/cdp` adds its `onReplaced` to a network-scoped account's wait options only when they are a plain object
  (prototype `Object.prototype` or `null`). Other options, such as a class instance, are passed to the SDK as they are:
  the wait is traced, but a replacement viem reports for it is not attributed.

The options of `withHashspan()` in `@hashspan/viem`, `@hashspan/cdp` and `@hashspan/x402` are read from the object's
own enumerable properties, so options inherited through a prototype are ignored (ADR 0025). This is now stated in the
options' documentation and the package READMEs.
