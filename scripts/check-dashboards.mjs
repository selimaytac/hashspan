// Runs every PromQL query of dashboards/*.json against Prometheus and prints how many series each returns; a query
// that fails, or returns nothing outside the panels that stay empty on a healthy run (EXPECTED_EMPTY), fails the check.
// TraceQL queries need Tempo, which the local stack does not run, and are skipped.
// Usage: node scripts/check-dashboards.mjs [--since <seconds ago>], after `make lab-metrics` and `make demo`.
// PROMETHEUS_URL sets Prometheus (default http://127.0.0.1:9090).
import { readdirSync, readFileSync } from 'node:fs';

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? Number(process.argv[sinceArg + 1]) : 3600;
// Panels that stay empty while nothing fails, by file and panel title and query refId.
const EXPECTED_EMPTY = {
  'metrics.json': ['Failures by error.type [A]', 'Failures by error.type [B]'],
};
const dir = new URL('../dashboards/', import.meta.url);
// With millisecond precision: the demo's samples are written just before it exits, so a time rounded down to the
// second can fall before them and make every query empty. It is this host's clock, as the samples' timestamps are.
const time = Date.now() / 1000;

// The values Grafana gives the variables with every service and chain selected, and a window that covers the run.
const substitute = (query) =>
  query
    .replaceAll('$job', '.+')
    .replaceAll('$chain', '.*')
    .replaceAll('$__range', `${since}s`)
    .replaceAll('$__rate_interval', `${since}s`);

function panels(node, out = []) {
  if (Array.isArray(node)) for (const item of node) panels(item, out);
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.targets)) out.push(node);
    for (const value of Object.values(node))
      if (value && typeof value === 'object') panels(value, out);
  }
  return out;
}

async function prometheus(expr) {
  const url = `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}&time=${time}`;
  const response = await fetch(url);
  const body = await response.json().catch(() => ({ error: `${response.status}` }));
  if (body.status !== 'success') return { error: body.error ?? `${response.status}` };
  return { count: body.data.result.length };
}

let failures = 0;
let checked = 0;
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()) {
  const dashboard = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  console.log(file);
  for (const panel of panels(dashboard.panels ?? [])) {
    for (const target of panel.targets) {
      if (target.queryType === 'traceql' || target.datasource?.type === 'tempo') continue;
      if (!target.expr) continue;
      const name = `${panel.title} [${target.refId}]`;
      const result = await prometheus(substitute(target.expr));
      const empty = !result.error && result.count === 0 && !EXPECTED_EMPTY[file]?.includes(name);
      if (result.error || empty) failures++;
      checked++;
      const status = result.error
        ? `ERROR ${result.error}`
        : `${result.count} series${empty ? ' EMPTY' : ''}`;
      console.log(`  ${status.padEnd(16)} ${name}`);
    }
  }
}
if (checked === 0) {
  console.error('no PromQL query found in dashboards/');
  failures++;
}
process.exitCode = failures > 0 ? 1 : 0;
