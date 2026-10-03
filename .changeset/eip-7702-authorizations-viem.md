---
'@hashspan/viem': minor
---

`sendTransaction` and `writeContract` record the `authorizationList` of an EIP-7702 transaction on its send span:
how many authorizations, each delegated address and its chain id, read from own data properties (only the first 64
entries are read; all are counted). Signatures and nonces never reach telemetry. With an older `@hashspan/core`, the
list is not recorded.
