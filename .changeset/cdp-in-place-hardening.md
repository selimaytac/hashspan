---
'@hashspan/cdp': patch
---

A network name that matches an `Object.prototype` member, such as `constructor`, is no longer taken for a known
network, so no span starts with a non-numeric chain id. The methods `withHashspan()` wraps in place keep the
enumerability of the original property and are not enumerable where the SDK's were inherited, so `Object.keys`,
object spread and `JSON.stringify` of `cdp.evm` and of accounts are the same as before wrapping; a read-only or
accessor property is left as it is.
