---
'@hashspan/mpp': minor
---

Add `@hashspan/mpp`, 0.x while mppx is (ADR 0029): `withHashspan(mppx, { reader })` registers observers on the client
`Mppx.create()` returns, so each Tempo `charge` paid through its `fetch`, push or pull, becomes a `payment {chainId}`
span with the payer, recipient, asset, amount, `mpp.mode`, `mpp.challenge.id`, the resource and the settlement. The
payer's own hash is recorded from the start (push, and pull without a fee payer), and kept over another one the server
reports; with a reader, a linked confirm span, and `blockchain.payment.verified` from the transfer of the payer with
the challenge's memo, and each split. Payments without an outcome event end as `timeout`. Requires `@hashspan/core`
1.2, `mppx` `~0.13.5` and `viem` 2.57.1 or later.
