---
'@hashspan/cdp': patch
---

Reads a user operation's outcome only from its EntryPoint: with a `reader`, the confirm span takes the
`UserOperationEvent` of the contract the bundle transaction called or of a canonical EntryPoint (0.6 to 0.9), and
ignores logs of other contracts.
