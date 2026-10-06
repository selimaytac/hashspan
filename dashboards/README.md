# Grafana dashboards

Two Grafana dashboards for what hashspan records: one on the metrics, one on the spans.

| File | Shows | Needs |
|---|---|---|
| [`metrics.json`](metrics.json) | Sends, failed sends, confirmation latency, fees (median, total and average, per chain and per service), the fee distribution, and send and confirmation outcomes of transactions, user operations and call batches, in the selected range and over time | A Prometheus data source that receives hashspan's [metrics](../docs/semconv.md#metrics) over OTLP |
| [`traces.json`](traces.json) | Confirm spans with their outcome, fee (with the L1 part on OP-stack chains) and revert reason; x402 payments, and those not verified or failed; failed and slow JSON-RPC requests of `traceTransport()` | A Tempo data source (TraceQL), and the Prometheus data source of `metrics.json` for its Service and Chain id lists |

Both dashboards have the same variables:

- **Metrics** (`datasource`) and, in `traces.json`, **Traces** (`traces`): the data sources, chosen from the
  Prometheus and Tempo data sources of your Grafana, whatever their names; with several, check the one selected. The
  same file therefore works in a local Grafana and in Grafana Cloud (`grafanacloud-<stack>-prom`,
  `grafanacloud-<stack>-traces`).
- **Service** (`job`): Prometheus' `job` label, which is `service.name`, or `service.namespace/service.name` when
  the namespace is set. `traces.json` matches it against `resource.service.name`, so set no `service.namespace` to
  filter spans by service.
- **Chain id** (`chain`): `blockchain_chain_id` in Prometheus. In TraceQL, the panels match the chain id in the span
  name (`confirm 8453`, `payment 8453`), since the attribute is an integer; the JSON-RPC tables are named after their
  method and filter by service only.

The fee panels leave out fees that someone other than the sender paid (`blockchain_fee_payer=""`, see
`blockchain.fee.payer`). No panel filters on `blockchain.system.name`.

## Use them

In the local lab, `make lab-metrics` starts Prometheus and Grafana with `metrics.json` provisioned as the home
dashboard on `http://localhost:3000`, and `make demo` fills it. The lab runs Jaeger, not Tempo, so `traces.json` is
not provisioned there.

Elsewhere, import a file in Grafana (Dashboards, New, Import) and pick the data sources in the variables at the top.
What Prometheus needs to receive the metrics, and how the counts in a range are computed, is in
[Grafana dashboard for the metrics](../docs/backends.md#grafana-dashboard-for-the-metrics).

## Versions

The dashboards query only metric and attribute names of [docs/semconv.md](../docs/semconv.md) that hashspan 1.0
already records, which 1.x keeps ([ADR 0027](../docs/adr/0027-what-1-0-freezes.md)), so they work with every 1.x
release. CI runs `make lab-check` after `make demo`: it runs every PromQL query of these files against the lab's
Prometheus and fails when one errors or, outside the panels that only show failures, returns nothing. The TraceQL
queries are not checked in CI, since the lab has no Tempo.
