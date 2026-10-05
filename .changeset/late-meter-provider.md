---
'@hashspan/core': patch
---

A tracker whose first transaction is sent before an SDK registers a global meter provider now records metrics once
one is registered. It no longer keeps the histograms of `@opentelemetry/api`'s default no-op meter provider, which stay
no-op: while no `meterProvider` option is given and the global provider is still the no-op one, the tracker asks again
at the next transaction, and keeps the histograms once a real provider answers. Spans already behaved this way.
Transactions sent before the SDK started are not recorded.
