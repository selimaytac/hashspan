---
"@hashspan/core": minor
"@hashspan/viem": patch
---

Keep error messages out of spans by default: failed spans record only the error type. The new `errorMessages`
option records a sanitized first line (`'sanitized'`, addresses per address mode, calldata removed) or the full
message and stack trace (`'raw'`). The redaction hook now also runs on exception attributes, addresses in revert
reasons follow the address mode, and the viem adapter logs only error names through `diag`.
