---
'@hashspan/viem': patch
---

A chain id is taken only if it is a positive safe integer: a node that answers `eth_chainId` with `0x0`, or a call
whose `chain` has an id of 0, a negative or a non-integer number, no longer gives a span with that id. A call that
names such a chain is not recorded under the client's chain either.
