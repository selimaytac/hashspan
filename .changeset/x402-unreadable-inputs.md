---
'@hashspan/x402': patch
---

A settlement response that cannot be read ends the payment span with `error.type` `_OTHER` instead of leaving it open
until its deadline. `withHashspan()` no longer throws for a client or a tracker it cannot read: the payments are then
not traced, with a `diag` warning.
