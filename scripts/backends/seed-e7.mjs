// Results of the five backends of experiment E7 (2026-10-18), recomputed with diff.mjs from E7's recorded spans:
// what hashspan 1.1.0 (viem 2.57.7) sent on Anvil over OTLP/HTTP protobuf, and what each backend returned, already
// in the common span shape by E7's read-back code (its raw responses were not kept). This is the "hashspan in X"
// corpus, not the synthetic one of corpus.mjs, so the rows name their own corpus id.
// Usage: node scripts/backends/seed-e7.mjs   (writes docs/backends/results/<backend>@<version>.json)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResult, metricResult, traceResult, writeResult } from './result.mjs';

/** Fixtures with E7's recorded spans, relative to the repository root. */
export const E7_FIXTURES = 'packages/core/test/fixtures/backends-e7';

export const E7_CORPUS_ID = 'e7-hashspan-1.1.0-anvil';

/** The five E7 backends with the images E7 ran (experiments/e7-otel-backends, Versions). */
export const E7_BACKENDS = {
  aspire: {
    title: 'Aspire dashboard',
    image: 'mcr.microsoft.com/dotnet/aspire-dashboard:13.6.1',
    digest: 'sha256:03099004e132a7ca2feb66c5fa24715ffeaaf2fffab6f8b2cda23de3abd3ea45',
    readApi: 'telemetry API `/api/telemetry/traces/{id}`',
    metrics: { note: 'its telemetry API has no metrics route' },
    notes: [],
  },
  'otel-lgtm': {
    title: 'grafana/otel-lgtm (Tempo)',
    image: 'grafana/otel-lgtm:0.37.0',
    digest: 'sha256:57b5ab1ca6619beb180174e2fccce04762470750669d043f544b4726d0582d07',
    readApi: 'Tempo `/api/v2/traces/{id}`, Prometheus query API',
    metrics: {},
    notes: ['Tempo 3.1.0 and Prometheus 3.15.0 inside'],
  },
  openobserve: {
    title: 'OpenObserve',
    image: 'openobserve/openobserve:v1.1.1',
    digest: 'sha256:dae91bc1f9d4c11db54e924d8d25bac7f6c50e080a8f06fc90d9468eaab81b67',
    readApi: 'SQL search `/api/default/_search?type=traces`, PromQL',
    metrics: {
      note: 'series named without `_seconds`, such as `blockchain_client_send_duration_count`',
    },
    notes: [],
  },
  hyperdx: {
    title: 'HyperDX (local)',
    image: 'hyperdx/hyperdx-local:2.41.0',
    digest: 'sha256:9236f043e8ad0a7cb87df1875850898c69439ef26f870ce10dcf49b79d09c16b',
    readApi: 'ClickHouse `default.otel_traces`',
    metrics: {},
    notes: [],
  },
  mlflow: {
    title: 'MLflow',
    image: 'ghcr.io/mlflow/mlflow:v3.17.1',
    digest: 'sha256:65aa7a75fe37554bd7dd9e539b58e1ec130dac99f27fef9756df316a272dfee2',
    readApi: 'REST `/api/3.0/mlflow/traces/batchGet`',
    metrics: { status: 404, note: 'no OTLP metrics endpoint' },
    notes: [
      'span kind dropped on OTLP ingest: [mlflow/mlflow#26841](https://github.com/mlflow/mlflow/issues/26841)',
      'link trace ids come back as `tr-<hex>` and resolve',
    ],
  },
};

/** Reads one E7 fixture: `meta`, `metrics` ({ expected, got } or null), `sent` and `received` spans. */
export function readE7Fixture(root, backend) {
  return JSON.parse(readFileSync(join(root, E7_FIXTURES, `${backend}.json`), 'utf8'));
}

/** The result of an E7 backend, computed from its fixture. */
export function e7Result(root, name) {
  const def = E7_BACKENDS[name];
  const fixture = readE7Fixture(root, name);
  const sha256 = createHash('sha256').update(JSON.stringify(fixture.sent)).digest('hex');
  const metrics = fixture.metrics
    ? metricResult(fixture.metrics.expected, fixture.metrics.got, def.metrics)
    : metricResult(undefined, undefined, def.metrics);
  return buildResult({
    corpus: { id: E7_CORPUS_ID, sha256 },
    harness: {
      commit: null,
      source: 'experiment E7, recomputed from its recorded spans with diff.mjs',
    },
    backend: {
      name,
      title: def.title,
      version: fixture.meta.version,
      image: def.image,
      digest: def.digest,
      readApi: def.readApi,
    },
    runDate: '2026-10-18',
    transports: {
      'http/protobuf': { traces: traceResult(fixture.sent, fixture.received), metrics },
    },
    notes: def.notes,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const name of Object.keys(E7_BACKENDS)) console.log(writeResult(root, e7Result(root, name)));
}
