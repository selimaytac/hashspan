---
'@hashspan/core': minor
---

`blockchain.system` is renamed to `blockchain.system.name`, as OpenTelemetry names the system attribute of its
`db.*` and `rpc.*` conventions. Following the change policy of the semantic conventions, every span and metric sample
that records `blockchain.system` now records `blockchain.system.name` too, with the same value (`evm`); the redaction
hook's fail-closed set keeps both. Metric series therefore gain a label, `blockchain_system_name` in Prometheus: each series ends at the upgrade and
a new one starts, so `rate()` and `increase()` over a window that spans the upgrade undercount once.
Queries and dashboards should move to the new name: `blockchain.system` and the constant `ATTR_BLOCKCHAIN_SYSTEM`
are deprecated and removed in 1.0. New export: `ATTR_BLOCKCHAIN_SYSTEM_NAME`. The semantic conventions schema
version is `0.3.0-dev`. The doc comment of the `redact` option lists every key the fail-closed set keeps, call
batch keys included.
