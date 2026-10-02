---
'@hashspan/x402': minor
---

A Permit2 settlement is now verified by its nonce (ADR 0017): with a reader, when the receipt carries an `exact`
Permit2 or `upto` payment, the settlement transaction is read with one more request through the reader, and
`blockchain.payment.verified` is `true` only when its input passes the payer's Permit2 nonce and the payer as owner
to the proxy. The transaction of an earlier payment is therefore `false` in any client or process, also after a
restart; the in-memory list of the last 1000 verified transactions is removed. A transaction that cannot be read
gives no verdict.
