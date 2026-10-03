---
'@hashspan/viem': minor
---

`sendTransaction` and `writeContract` record the `authorizationList` of an EIP-7702 transaction on its send span:
how many authorizations, each delegated address and its chain id, read from own data properties. Signatures and
nonces never reach telemetry. With an older `@hashspan/core`, the list is not recorded.
