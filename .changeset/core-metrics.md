---
'@hashspan/core': minor
---

The tracker records metrics (ADR 0020): `blockchain.client.send.duration` and
`blockchain.client.confirmation.duration` histograms in seconds and `blockchain.client.fee` in wei, with the chain
and the outcome as their only attributes. They use the global meter provider, or the new `meterProvider` option,
and record nothing until a metrics SDK is set up. The metric names are exported as constants.
