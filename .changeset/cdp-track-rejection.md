---
'@hashspan/cdp': patch
---

Tracing work that `flush()` awaits can no longer surface as an unhandled rejection in the application's process if it
rejects, and `flush()` still resolves once it has settled.
