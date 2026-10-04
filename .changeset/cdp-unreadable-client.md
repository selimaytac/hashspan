---
'@hashspan/cdp': patch
---

`withHashspan()` no longer throws for a client whose `evm` cannot be read or marked as traced (a Proxy, a frozen
object, a missing `evm`): the client is then not traced, with a `diag` warning.
