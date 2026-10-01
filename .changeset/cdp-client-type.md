---
"@hashspan/cdp": patch
---

`withHashspan(cdp)` accepts a `CdpClient` of the CDP SDK in TypeScript. It used to fail to type-check with "Index
signature for type 'string' is missing in type 'EvmClient'", so the README's example needed a cast.
