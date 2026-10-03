---
'@hashspan/core': patch
---

`errorMessages: 'sanitized'` now cuts every URL in the recorded first line to its scheme, host and port, and records
`<url>` for one whose user info hides a `?` or `#`. viem keeps the request URL off the first line, but a custom
EIP-1193 transport or another library can put it there, with an API key in its path or query.
