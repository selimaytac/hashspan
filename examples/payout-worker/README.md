# Payout worker example

A worker that pays out from a queue, traced with hashspan. It is not an agent: each payout runs in a span of its own,
`payout <id>`, and hashspan's `send` and `confirm` spans nest under it. No agent identity is set; the `service.name`
of its OpenTelemetry resource, `payout-worker`, tells the worker apart.

- It signs with a local account and sends through a viem wallet client extended with `withHashspan()`.
- It does not wait for receipts: `confirm: { mode: 'background' }` records each confirmation, and `flush()` waits for
  them before the job exits.
- One payout goes to a contract that refuses it, so its send fails and the send span records the error.
- With a metrics endpoint set, the send, confirmation and fee histograms show latency and fees across all payouts.

## Run it

From the repository root, with the [local lab](../../README.md#local-lab):

```sh
make lab-up      # Jaeger UI on http://localhost:16686
make anvil       # in a second terminal: a local chain on :8545
pnpm --filter @hashspan/example-payout-worker start
```

Then search Jaeger for the service `payout-worker`: one trace per payout. `RPC_URL` points it at another local Anvil.
For the histograms in Grafana, run `make lab-metrics` and set
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:9090/api/v1/otlp/v1/metrics`, the lab's Prometheus.

`test/worker.int.test.ts` runs the worker against Anvil in CI.

See [Not an agent?](../../README.md#not-an-agent) and
[many transactions](../../packages/viem/README.md#many-transactions) for the limits that matter at volume.
