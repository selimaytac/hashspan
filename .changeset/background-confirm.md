---
"@hashspan/viem": minor
---

Add `confirm: { mode: 'background' }` to `withHashspan()`: sent transactions are confirmed without an explicit
wait, with at most one confirm span per transaction.
