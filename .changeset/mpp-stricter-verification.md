---
'@hashspan/mpp': patch
---

Stricter checks before recording a verified payment: for a sponsored pull, whose hash only the server's `reference`
names, `blockchain.payment.verified` is `true` only when the mined transaction, read once through the reader, was
sent by the payer with the nonce and validity fields of the transaction the payer signed; otherwise the payment has no
verdict. Push and unsponsored pull are unchanged. `flush()` does not wait for unpaid challenges: it waits only for
payments whose credential was created, and a challenge that was never paid is still dropped at its deadline.
