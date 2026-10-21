// One entry per backend: the image and its digest, the docker run arguments, how to tell it is ready, where it takes
// OTLP and how to read the spans and metrics back through its own query API. Every port is bound to 127.0.0.1, no
// path of the host is mounted (named volumes only), each container is limited to 2 GiB and named `e13-<backend>`.
// `tested: false` marks a read-back written from the backend's documentation and not yet run against it; the first
// run either confirms it or fixes it. `digest: null` is filled in from the pulled image by run.mjs and recorded in the
// result. The read-backs that E7 ran (Aspire, otel-lgtm, OpenObserve, HyperDX, MLflow) are ported from it.
import { randomBytes } from 'node:crypto';
import { instanceIdOf } from './corpus.mjs';
import {
  fromClickHouse,
  fromMlflow,
  fromOpenObserve,
  fromOtlpJson,
  fromPhoenix,
} from './normalize.mjs';

/** Memory limit of every backend container. */
export const MEMORY = '2g';
/** Prefix of every container and volume the harness creates (experiment e13). */
export const PREFIX = 'e13-';

const HEX = /^[0-9a-f]+$/;
/** Refuses anything but a hex id before it goes into a query. */
const checkId = (id) => {
  if (typeof id !== 'string' || !HEX.test(id)) throw new Error('not a hex id');
  return id;
};

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).pathname}`);
  return JSON.parse(text);
}

/** Counts per outcome of the three histograms through a Prometheus-compatible query API. */
async function promCounts(queryUrl, transport, names, init = {}) {
  const query = async (q) =>
    (await getJson(`${queryUrl}?query=${encodeURIComponent(q)}`, init)).data.result;
  const sel = `{service_instance_id="${instanceIdOf(transport)}"}`;
  const out = {};
  for (const [metric, series] of Object.entries(names)) {
    const rows = await query(`sum by (blockchain_tx_status, error_type) (${series}${sel})`);
    const by = {};
    for (const r of rows) {
      const key = r.metric.blockchain_tx_status ?? r.metric.error_type ?? 'none';
      by[key] = (by[key] ?? 0) + Number(r.value[1]);
    }
    out[metric] = { count: Object.values(by).reduce((a, b) => a + b, 0), by };
  }
  return out;
}

const PROMETHEUS_NAMES = {
  'blockchain.client.send.duration': 'blockchain_client_send_duration_seconds_count',
  'blockchain.client.confirmation.duration':
    'blockchain_client_confirmation_duration_seconds_count',
  'blockchain.client.fee': 'blockchain_client_fee_count',
};

/** ClickHouse HTTP query (HyperDX local's built-in `api` user, which only listens inside the container's ports). */
async function clickHouse(sql) {
  const response = await fetch('http://127.0.0.1:8123/', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from('api:api').toString('base64')}` },
    body: `${sql} FORMAT JSON`,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} from ClickHouse`);
  return JSON.parse(text).data;
}

const OPENOBSERVE_USER = 'root@example.com';
const openobserveAuth = (secrets) =>
  `Basic ${Buffer.from(`${OPENOBSERVE_USER}:${secrets.ZO_ROOT_USER_PASSWORD}`).toString('base64')}`;

/** @type {Record<string, any>} */
export const backends = {
  jaeger: {
    title: 'Jaeger',
    version: '2.22.0',
    image: 'jaegertracing/jaeger:2.22.0',
    digest: null,
    tested: false,
    ports: [4318, 16686],
    ready: ['http://127.0.0.1:16686/'],
    otlp: {
      traces: 'http://127.0.0.1:4318/v1/traces',
      metrics: 'http://127.0.0.1:4318/v1/metrics',
    },
    readApi: 'v3 `/api/v3/traces/{id}`',
    // The v3 query API answers in OTLP JSON under `result`.
    async readTrace(traceId) {
      const d = await getJson(`http://127.0.0.1:16686/api/v3/traces/${checkId(traceId)}`);
      return fromOtlpJson(d.result?.resourceSpans);
    },
  },
  'otel-lgtm': {
    title: 'grafana/otel-lgtm (Tempo)',
    version: '0.37.0',
    image: 'grafana/otel-lgtm:0.37.0',
    digest: 'sha256:57b5ab1ca6619beb180174e2fccce04762470750669d043f544b4726d0582d07',
    tested: true,
    ports: [4318, 3200, 9090],
    env: { GF_ANALYTICS_REPORTING_ENABLED: 'false', GF_ANALYTICS_CHECK_FOR_UPDATES: 'false' },
    ready: ['http://127.0.0.1:3200/ready', 'http://127.0.0.1:9090/-/ready'],
    otlp: {
      traces: 'http://127.0.0.1:4318/v1/traces',
      metrics: 'http://127.0.0.1:4318/v1/metrics',
    },
    readApi: 'Tempo `/api/v2/traces/{id}`, Prometheus query API',
    async readTrace(traceId) {
      const d = await getJson(`http://127.0.0.1:3200/api/v2/traces/${checkId(traceId)}`);
      return fromOtlpJson(d.trace?.resourceSpans);
    },
    readMetrics: (transport) =>
      promCounts('http://127.0.0.1:9090/api/v1/query', transport, PROMETHEUS_NAMES),
  },
  aspire: {
    title: 'Aspire dashboard',
    version: '13.6.1',
    image: 'mcr.microsoft.com/dotnet/aspire-dashboard:13.6.1',
    digest: 'sha256:03099004e132a7ca2feb66c5fa24715ffeaaf2fffab6f8b2cda23de3abd3ea45',
    tested: true,
    // 18888 serves the UI and the telemetry API, 18890 takes OTLP over HTTP.
    ports: [18888, { host: 4318, container: 18890 }],
    env: { DASHBOARD__FRONTEND__AUTHMODE: 'Unsecured', DASHBOARD__OTLP__AUTHMODE: 'Unsecured' },
    ready: ['http://127.0.0.1:18888/'],
    otlp: {
      traces: 'http://127.0.0.1:4318/v1/traces',
      metrics: 'http://127.0.0.1:4318/v1/metrics',
    },
    readApi: 'telemetry API `/api/telemetry/traces/{id}`',
    async readTrace(traceId) {
      const d = await getJson(`http://127.0.0.1:18888/api/telemetry/traces/${checkId(traceId)}`);
      return fromOtlpJson(d.data?.resourceSpans).filter((s) => s.traceId === traceId);
    },
    metricsNote: 'its telemetry API has no metrics route',
  },
  openobserve: {
    title: 'OpenObserve',
    version: '1.1.1',
    image: 'openobserve/openobserve:v1.1.1',
    digest: 'sha256:dae91bc1f9d4c11db54e924d8d25bac7f6c50e080a8f06fc90d9468eaab81b67',
    tested: true,
    ports: [5080],
    env: { ZO_ROOT_USER_EMAIL: OPENOBSERVE_USER, ZO_TELEMETRY: 'false', ZO_DATA_DIR: '/data' },
    // The root password must hold upper and lower case letters, a digit and a special character, or the server
    // exits at start; a new one is made for every run.
    secrets: () => ({ ZO_ROOT_USER_PASSWORD: `Aa1!${randomBytes(18).toString('base64url')}` }),
    volumes: [{ name: 'data', path: '/data' }],
    ready: ['http://127.0.0.1:5080/healthz'],
    otlp: {
      traces: 'http://127.0.0.1:5080/api/default/v1/traces',
      metrics: 'http://127.0.0.1:5080/api/default/v1/metrics',
      headers: (secrets) => ({ authorization: openobserveAuth(secrets) }),
    },
    readApi: 'SQL search `/api/default/_search?type=traces`, PromQL',
    async readTrace(traceId, { secrets }) {
      const now = Date.now() * 1000;
      const body = {
        query: {
          sql: `SELECT * FROM "default" WHERE trace_id='${checkId(traceId)}'`,
          start_time: now - 3_600_000_000,
          end_time: now + 60_000_000,
          from: 0,
          size: 5000,
        },
      };
      const d = await getJson('http://127.0.0.1:5080/api/default/_search?type=traces', {
        method: 'POST',
        headers: { authorization: openobserveAuth(secrets), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return fromOpenObserve(d.hits);
    },
    // OpenObserve names the series without Prometheus' unit suffix.
    readMetrics: (transport, { secrets }) =>
      promCounts(
        'http://127.0.0.1:5080/api/default/prometheus/api/v1/query',
        transport,
        {
          'blockchain.client.send.duration': 'blockchain_client_send_duration_count',
          'blockchain.client.confirmation.duration':
            'blockchain_client_confirmation_duration_count',
          'blockchain.client.fee': 'blockchain_client_fee_count',
        },
        { headers: { authorization: openobserveAuth(secrets) } },
      ),
  },
  hyperdx: {
    title: 'HyperDX (local)',
    version: '2.41.0',
    image: 'hyperdx/hyperdx-local:2.41.0',
    digest: 'sha256:9236f043e8ad0a7cb87df1875850898c69439ef26f870ce10dcf49b79d09c16b',
    tested: true,
    ports: [4318, 8123],
    ready: ['http://127.0.0.1:8123/ping'],
    otlp: {
      traces: 'http://127.0.0.1:4318/v1/traces',
      metrics: 'http://127.0.0.1:4318/v1/metrics',
    },
    readApi: 'ClickHouse `default.otel_traces`',
    async readTrace(traceId) {
      return fromClickHouse(
        await clickHouse(`SELECT * FROM default.otel_traces WHERE TraceId = '${checkId(traceId)}'`),
      );
    },
    async readMetrics(transport) {
      const id = instanceIdOf(transport);
      const rows = await clickHouse(
        `SELECT MetricName, toJSONString(Attributes) AS attrs, argMax(Count, TimeUnix) AS count FROM default.otel_metrics_histogram WHERE ResourceAttributes['service.instance.id'] = '${id}' GROUP BY MetricName, Attributes`,
      );
      const out = {};
      for (const r of rows) {
        const a = JSON.parse(r.attrs);
        out[r.MetricName] ??= { count: 0, by: {} };
        const m = out[r.MetricName];
        const key = a['blockchain.tx.status'] ?? a['error.type'] ?? 'none';
        m.count += Number(r.count);
        m.by[key] = (m.by[key] ?? 0) + Number(r.count);
      }
      return out;
    },
  },
  mlflow: {
    title: 'MLflow',
    version: '3.17.1',
    image: 'ghcr.io/mlflow/mlflow:v3.17.1',
    digest: 'sha256:65aa7a75fe37554bd7dd9e539b58e1ec130dac99f27fef9756df316a272dfee2',
    tested: true,
    ports: [5000],
    // One worker and no job execution keep it far below the limit; the default server sat at 2 GiB in E7.
    command: ['mlflow', 'server', '--host', '0.0.0.0', '--port', '5000', '--workers', '1'],
    env: { MLFLOW_SERVER_ENABLE_JOB_EXECUTION: 'false', MLFLOW_DISABLE_TELEMETRY: 'true' },
    ready: ['http://127.0.0.1:5000/health'],
    otlp: {
      traces: 'http://127.0.0.1:5000/v1/traces',
      metrics: 'http://127.0.0.1:5000/v1/metrics',
      // The Default experiment, which every MLflow server has.
      headers: () => ({ 'x-mlflow-experiment-id': '0' }),
    },
    readApi: 'REST `/api/3.0/mlflow/traces/batchGet`',
    async readTrace(traceId) {
      const d = await getJson(
        `http://127.0.0.1:5000/api/3.0/mlflow/traces/batchGet?trace_ids=tr-${checkId(traceId)}`,
      );
      return fromMlflow(d.traces?.[0]?.spans);
    },
  },
  phoenix: {
    title: 'Phoenix',
    version: '20.21.1',
    image: 'arizephoenix/phoenix:20.21.1',
    digest: 'sha256:4a58a611389459514a936960d306776b976ed66c96649cef834bbc683ae5b4ab',
    tested: false,
    ports: [6006],
    env: {
      PHOENIX_WORKING_DIR: '/mnt/data',
      PHOENIX_TELEMETRY_ENABLED: 'false',
      PHOENIX_ALLOW_EXTERNAL_RESOURCES: 'false',
    },
    volumes: [{ name: 'data', path: '/mnt/data' }],
    // The first start runs the database migrations, about two minutes.
    ready: ['http://127.0.0.1:6006/healthz'],
    readyTimeoutMs: 300_000,
    otlp: {
      traces: 'http://127.0.0.1:6006/v1/traces',
      metrics: 'http://127.0.0.1:6006/v1/metrics',
    },
    readApi: 'REST `/v1/projects/default/spans/otlpv1`',
    async readTrace(traceId) {
      checkId(traceId);
      const d = await getJson('http://127.0.0.1:6006/v1/projects/default/spans/otlpv1?limit=1000');
      return fromPhoenix(d.data).filter((s) => s.traceId === traceId);
    },
  },
  langfuse: {
    title: 'Langfuse',
    version: null,
    trial: true,
    note: 'several containers (web, worker, Postgres, ClickHouse, Redis, MinIO); a trial within 4 GiB in total, not run by run.mjs yet',
  },
};

/** Host and container port of a port entry. */
const portOf = (p) => (typeof p === 'number' ? { host: p, container: p } : p);

/** Container name of a backend. */
export const containerOf = (name) => `${PREFIX}${name}`;
/** Named volumes of a backend, with their full names. */
export const volumesOf = (name, def) =>
  (def.volumes ?? []).map((v) => ({ name: `${PREFIX}${name}-${v.name}`, path: v.path }));

/**
 * `docker run` arguments of a backend. Secret values are passed by name only (`-e KEY`), so they come from the
 * environment of the docker process and never appear in its arguments.
 */
export function dockerArgs(
  name,
  def,
  image = def.digest ? `${def.image}@${def.digest}` : def.image,
) {
  if (!def.image) throw new Error(`${name} has no image the harness can run`);
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerOf(name),
    `--memory=${MEMORY}`,
    ...(def.ports ?? []).flatMap((p) => {
      const { host, container } = portOf(p);
      return ['--publish', `127.0.0.1:${host}:${container}`];
    }),
    ...Object.entries(def.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...Object.keys(def.secrets?.() ?? {}).flatMap((k) => ['--env', k]),
    ...volumesOf(name, def).flatMap((v) => ['--volume', `${v.name}:${v.path}`]),
    image,
    ...(def.command ?? []),
  ];
}
