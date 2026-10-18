---
'@hashspan/viem': patch
---

Bounds what it reads from a wallet's call batch results: a fallback batch id is parsed only up to 8194 characters,
at most 64 of its transactions are recorded and confirmed, and at most 64 receipts are read from a call batch status.
