---
'@hashspan/viem': patch
---

README: the known limit on a wait that resolves with another transaction's receipt describes the behaviour since
0.12.0 (the confirm span ends with `error.type` `_OTHER`), not the earlier one.
