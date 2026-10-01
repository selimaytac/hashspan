---
'@hashspan/x402': minor
---

Add `@hashspan/x402`: `withHashspan(client, { reader })` registers hooks on an `x402Client`, so each payment made
through `@x402/fetch`, `@x402/axios` or `@x402/mcp` becomes a `payment {chainId}` span with the payer, recipient,
asset, amount, scheme, resource and settlement, and, with a reader, a linked confirm span for the settling
transaction (ADR 0013). The confirm span does not check that the reported transaction is the payment, and revert
reasons of settlements are replayed only with `decodeRevertReason: true`. Payments without a response end as
`timeout`; x402 v1 and non-EVM payments are not traced.
