---
"@hashspan/viem": patch
---

Tracing `writeContract` no longer runs getters inside the ABI. To find the function selector and to decode revert
reasons, the adapter now uses a copy of the needed ABI items (the called function's overloads and the errors) made
of own data properties only, so an ABI built at runtime with accessors encodes the same call as without tracing.
