---
'@hashspan/viem': patch
'@hashspan/x402': patch
---

`watch()` with a `chainId` and a client without a chain now asks the client for its chain id (`eth_chainId`) and
records nothing when the two differ, as it already did for a client with a chain. Before, the transaction was polled
on the client's chain and recorded under the given chain id. In `@hashspan/x402` that chain id comes from the paid
server, so a reader without a chain could record a confirm span, and its `blockchain.chain.id` metric label, for any
chain the server named.
