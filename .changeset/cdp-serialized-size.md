---
'@hashspan/cdp': patch
---

Bounds the size of serialized transactions it parses: a send span records the fields of a serialized transaction
only up to 128 KiB, the size a node accepts, as `@hashspan/viem` does for raw sends.
