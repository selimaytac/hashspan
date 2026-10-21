// Tests the parts of the backend matrix (scripts/backends/) around the diff without running Docker: the docker run
// arguments of every backend, the result files and their host-data check, and the seeded E7 results.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  backends,
  containerOf,
  dockerArgs,
  MEMORY,
  volumesOf,
} from '../../../scripts/backends/backends.mjs';
import {
  buildResult,
  hostDataProblems,
  RESULTS_DIR,
  resultFile,
  resultText,
} from '../../../scripts/backends/result.mjs';
import { E7_BACKENDS, E7_FIXTURES, e7Result } from '../../../scripts/backends/seed-e7.mjs';
import { table } from '../../../scripts/backends/table.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runnable = Object.entries(backends).filter(([, def]) => !def.trial);

/** Values of one flag in a docker argument list. */
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

describe('backend matrix definitions', () => {
  it('cover the agreed backends, with Langfuse as a trial entry', () => {
    expect(Object.keys(backends)).toEqual([
      'jaeger',
      'otel-lgtm',
      'aspire',
      'openobserve',
      'hyperdx',
      'mlflow',
      'phoenix',
      'langfuse',
    ]);
    expect(backends.langfuse.trial).toBe(true);
    expect(() => dockerArgs('langfuse', backends.langfuse)).toThrow('no image');
  });

  it.each(runnable)(
    '%s runs as a removable, named, 2 GiB container on 127.0.0.1 only',
    (name, def) => {
      const args = dockerArgs(name, def);
      expect(args.slice(0, 3)).toEqual(['run', '--detach', '--rm']);
      expect(values(args, '--name')).toEqual([`e13-${name}`]);
      expect(containerOf(name)).toBe(`e13-${name}`);
      expect(args).toContain(`--memory=${MEMORY}`);
      expect(MEMORY).toBe('2g');
      const ports = values(args, '--publish');
      expect(ports.length).toBeGreaterThan(0);
      for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
      expect(args.some((a) => a === '-p' || a === '-v' || a.startsWith('--mount'))).toBe(false);
      // Named volumes only: no path of the host is mounted.
      for (const volume of values(args, '--volume'))
        expect(volume).toMatch(/^e13-[a-z0-9-]+:\/[^:]*$/);
      expect(volumesOf(name, def).every((v: { name: string }) => v.name.startsWith('e13-'))).toBe(
        true,
      );
      // Every URL the harness calls is local.
      for (const url of [...def.ready, def.otlp.traces, def.otlp.metrics]) {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      }
      expect(typeof def.readTrace).toBe('function');
    },
  );

  it.each(runnable)(
    '%s pins its image to a digest, or leaves it for the run to record',
    (_name, def) => {
      expect(def.digest === null || /^sha256:[0-9a-f]{64}$/.test(def.digest)).toBe(true);
      const image = dockerArgs(_name, def).find((a) => a.startsWith(def.image));
      expect(image).toBe(def.digest ? `${def.image}@${def.digest}` : def.image);
    },
  );

  it('passes secrets by name only, never their value', () => {
    const def = backends.openobserve;
    const secrets = def.secrets();
    const args = dockerArgs('openobserve', def);
    expect(values(args, '--env')).toContain('ZO_ROOT_USER_PASSWORD');
    expect(args.join(' ')).not.toContain(secrets.ZO_ROOT_USER_PASSWORD);
    expect(def.secrets().ZO_ROOT_USER_PASSWORD).not.toBe(secrets.ZO_ROOT_USER_PASSWORD);
    expect(secrets.ZO_ROOT_USER_PASSWORD).toMatch(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w]).{12,}$/,
    );
  });

  it('turns telemetry off where the backend has a switch for it', () => {
    expect(backends.openobserve.env.ZO_TELEMETRY).toBe('false');
    expect(backends.mlflow.env.MLFLOW_DISABLE_TELEMETRY).toBe('true');
    expect(backends.phoenix.env.PHOENIX_TELEMETRY_ENABLED).toBe('false');
    expect(backends.phoenix.env.PHOENIX_ALLOW_EXTERNAL_RESOURCES).toBe('false');
    expect(backends['otel-lgtm'].env.GF_ANALYTICS_REPORTING_ENABLED).toBe('false');
  });

  it('opens the Aspire telemetry API, which has an auth mode of its own', () => {
    expect(backends.aspire.env.DASHBOARD__API__AUTHMODE).toBe('Unsecured');
  });

  it('waits for the HyperDX collector, not only for ClickHouse', () => {
    expect(backends.hyperdx.ready).toContain('http://127.0.0.1:13133/');
    expect(values(dockerArgs('hyperdx', backends.hyperdx), '--publish')).toContain(
      '127.0.0.1:13133:13133',
    );
  });

  it('marks the read-backs not yet run against their backend', () => {
    const untested = runnable.filter(([, def]) => !def.tested).map(([name]) => name);
    expect(untested).toEqual([]);
  });

  it('refuses a trace id that is not hex before it reaches a query', async () => {
    await expect(backends.hyperdx.readTrace("x' OR 1=1 --")).rejects.toThrow('not a hex id');
    await expect(backends.openobserve.readTrace("'", { secrets: {} })).rejects.toThrow(
      'not a hex id',
    );
  });
});

describe('backend matrix results', () => {
  const files = readdirSync(join(root, RESULTS_DIR)).filter((f) => f.endsWith('.json'));

  it('finds the result files it checks', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)('%s is named after its backend and version and holds no host data', (file) => {
    const text = readFileSync(join(root, RESULTS_DIR, file), 'utf8');
    const result = JSON.parse(text);
    expect(resultFile(result.backend.name, result.backend.version, result.corpus.id)).toBe(file);
    expect(result.schema).toBe(1);
    expect(result.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(text).toBe(resultText(result));
    expect(hostDataProblems(text)).toEqual([]);
  });

  it('keeps no E7 seed row for a backend that has a synthetic-1 row', () => {
    const results = files.map((f) => JSON.parse(readFileSync(join(root, RESULTS_DIR, f), 'utf8')));
    const synthetic = new Set(
      results.filter((r) => r.corpus.id === 'synthetic-1').map((r) => r.backend.name),
    );
    const seeded = results.filter((r) => r.corpus.id !== 'synthetic-1').map((r) => r.backend.name);
    expect(seeded.filter((name) => synthetic.has(name))).toEqual([]);
    for (const name of Object.keys(E7_BACKENDS)) {
      expect(e7Result(root, name).corpus.id).toBe('e7-hashspan-1.1.0-anvil');
    }
  });

  it('names a result of another corpus apart, so a run of the matrix keeps the E7 seed of the same version', () => {
    expect(resultFile('aspire', '13.6.1')).toBe('aspire@13.6.1.json');
    expect(resultFile('aspire', '13.6.1', 'synthetic-1')).toBe('aspire@13.6.1.json');
    expect(resultFile('aspire', '13.6.1', 'e7-hashspan-1.1.0-anvil')).toBe(
      'aspire@13.6.1.e7-hashspan-1.1.0-anvil.json',
    );
  });

  it('keeps host data out of the E7 fixtures', () => {
    for (const file of readdirSync(join(root, E7_FIXTURES))) {
      const text = readFileSync(join(root, E7_FIXTURES, file), 'utf8');
      expect({ file, problems: hostDataProblems(text) }).toEqual({ file, problems: [] });
    }
  });

  it('finds paths, addresses, times and host values', () => {
    expect(hostDataProblems('"at /Users/someone/x"')).toEqual(['a file path']);
    expect(hostDataProblems('"C:\\\\x"')).toEqual(['a file path']);
    expect(hostDataProblems('"10.0.0.7 and 127.0.0.1"')).toEqual(['the address 10.0.0.7']);
    expect(hostDataProblems('"2026-10-21T10:00:00Z"')).toEqual(['a time of day']);
    expect(hostDataProblems('"made on box-42"', ['box-42'])).toEqual(['a host value']);
    expect(hostDataProblems('"2026-10-21", "/api/v3/traces", "127.0.0.1"')).toEqual([]);
  });

  it('builds results with a date only', () => {
    expect(() =>
      buildResult({
        corpus: {},
        harness: {},
        backend: {},
        runDate: '2026-10-21T00:00',
        transports: {},
      }),
    ).toThrow('runDate');
  });

  it('generates the table from the synthetic-1 runs', () => {
    expect(table([])).toBe('No results yet: the first lab run of the matrix writes them.');
    const results = files.map((file) => ({
      file,
      result: JSON.parse(readFileSync(join(root, RESULTS_DIR, file), 'utf8')),
    }));
    const text = table(results);
    expect(text).toContain('| MLflow 3.17.1 | `synthetic-1` | all kept | **dropped** |');
    expect(text).toContain('**dots become underscores**');
    // Aspire, HyperDX and OpenObserve return every attribute as a string, as in E7.
    expect(
      text.split('\n').filter((l) => l.includes('**strings** (array, boolean, number sent)')),
    ).toHaveLength(3);
    expect(text).not.toContain('No backend has a `synthetic-1` result yet');
  });

  it('says only "refused" for a transport the backend refused', () => {
    const file = files[0] as string;
    const result = JSON.parse(readFileSync(join(root, RESULTS_DIR, file), 'utf8'));
    const [name, t] = Object.entries(result.transports)[0] as [string, { traces: object }];
    const refused = {
      ...result,
      transports: { [name]: { ...t, traces: { ...t.traces, status: 415 } } },
    };
    const row = table([{ file, result: refused }]).split('\n')[2] as string;
    expect(row).toContain('| refused (415) | - | - | - | - | - | - | - |');
  });

  it('escapes backslashes and pipes in table cells', () => {
    const file = files[0] as string;
    const result = JSON.parse(readFileSync(join(root, RESULTS_DIR, file), 'utf8'));
    const text = table([
      { file, result: { ...result, backend: { ...result.backend, title: 'a\\|b' } } },
    ]);
    expect(text).toContain('a\\\\\\|b');
  });
});
