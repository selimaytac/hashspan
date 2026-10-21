// Runs the backend matrix against one backend: starts its container, sends the corpus over each transport, reads it
// back through the backend's own API, diffs it and writes docs/backends/results/<backend>@<version>.json, then removes
// the container, its volumes and (unless --keep-image) its image. Needs Docker and the ports of the backend free on
// 127.0.0.1; run one backend at a time, with other stacks stopped.
// Usage: node scripts/backends/run.mjs <backend> [--transport http/protobuf|http/json] [--keep-image]
//        node scripts/backends/run.mjs --list
import { execFile } from 'node:child_process';
import { homedir, hostname, userInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { backends, containerOf, dockerArgs, volumesOf } from './backends.mjs';
import { CORPUS_ID, corpusHash, expectedMetricCounts, TRANSPORTS, traceIds } from './corpus.mjs';
import { encodeMetrics, encodeTraces, expectedSpans, post } from './otlp.mjs';
import { buildResult, metricResult, traceResult, writeResult } from './result.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

/** Runs docker with an argument array; secret values come through the environment only. */
const docker = (args, env = {}) =>
  run('docker', args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });

/** Polls each URL until it answers 2xx, or fails after `timeoutMs`. */
async function waitReady(urls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (const url of urls) {
    for (;;) {
      try {
        const response = await fetch(url);
        await response.arrayBuffer();
        if (response.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`not ready: ${new URL(url).pathname}`);
      await sleep(1000);
    }
  }
}

/**
 * Reads a trace until it holds `count` spans or `timeoutMs` passes; returns the last read and the last read error,
 * whose message names a status and a path only.
 */
async function readUntil(read, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let spans = [];
  let error;
  for (;;) {
    try {
      spans = await read();
      error = undefined;
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 120);
    }
    if (spans.length >= count || Date.now() > deadline) return { spans, error };
    await sleep(2000);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const [name, def] of Object.entries(backends)) {
      console.log(
        name,
        def.version ?? '-',
        def.trial ? 'trial' : def.tested ? 'tested' : 'untested',
      );
    }
    return;
  }
  const name = args.find((a) => !a.startsWith('--'));
  const def = backends[name];
  if (!def) throw new Error(`unknown backend; one of ${Object.keys(backends).join(', ')}`);
  if (def.trial) throw new Error(`${name} is a trial entry: ${def.note}`);
  const only = args.includes('--transport') ? args[args.indexOf('--transport') + 1] : undefined;
  if (only !== undefined && !TRANSPORTS.includes(only)) {
    throw new Error(`--transport is one of ${TRANSPORTS.join(', ')}`);
  }
  const transports = only ? [only] : TRANSPORTS;
  const secrets = def.secrets?.() ?? {};
  const headers = def.otlp.headers?.(secrets) ?? {};
  const image = def.digest ? `${def.image}@${def.digest}` : def.image;
  const container = containerOf(name);

  await docker(['pull', image]);
  const digest =
    def.digest ??
    (await docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', def.image])).stdout
      .trim()
      .split('@')[1];
  const { stdout: commit } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
  const transportsResult = {};
  try {
    await docker(dockerArgs(name, def, image), secrets);
    await waitReady(def.ready, def.readyTimeoutMs ?? 120_000);
    for (const transport of transports) {
      const sendTime = Date.now();
      const tracesStatus = await post(def.otlp.traces, encodeTraces(transport, sendTime), headers);
      const metricsStatus = await post(
        def.otlp.metrics,
        encodeMetrics(transport, sendTime),
        headers,
      );
      const expected = expectedSpans(transport, sendTime);
      const received = [];
      const readErrors = [];
      for (const traceId of Object.values(traceIds(transport))) {
        const count = expected.filter((s) => s.traceId === traceId).length;
        const { spans, error } = await readUntil(
          () => def.readTrace(traceId, { secrets }),
          count,
          def.readTimeoutMs ?? 60_000,
        );
        received.push(...spans);
        if (error) readErrors.push(error);
      }
      let got;
      let note = def.metricsNote;
      if (def.readMetrics && metricsStatus >= 200 && metricsStatus < 300) {
        await sleep(def.metricsDelayMs ?? 15_000);
        try {
          got = await def.readMetrics(transport, { secrets });
        } catch (error) {
          note = `read failed: ${String(error.message).slice(0, 120)}`;
        }
      }
      transportsResult[transport] = {
        traces: {
          ...traceResult(expected, received, tracesStatus),
          ...(readErrors.length ? { readErrors } : {}),
        },
        metrics: metricResult(expectedMetricCounts(), got, {
          status: metricsStatus,
          ...(note === undefined ? {} : { note }),
        }),
      };
    }
  } finally {
    // A failed removal is reported, so nothing of the run stays behind unnoticed.
    const remove = (what) =>
      docker(what).catch((e) =>
        console.error(`could not run docker ${what.join(' ')}: ${String(e?.stderr ?? e).trim()}`),
      );
    await remove(['rm', '--force', container]);
    for (const v of volumesOf(name, def)) await remove(['volume', 'rm', v.name]);
    // An image pulled by digest has no tag locally; it is removed by its repository and digest.
    const local = def.digest ? `${def.image.replace(/:[^/:]+$/, '')}@${def.digest}` : def.image;
    if (!args.includes('--keep-image')) await remove(['image', 'rm', local]);
  }
  const result = buildResult({
    corpus: { id: CORPUS_ID, sha256: corpusHash() },
    harness: { commit: commit.trim() },
    backend: {
      name,
      title: def.title,
      version: def.version,
      image: def.image,
      digest: digest ?? null,
      readApi: def.readApi,
    },
    runDate: new Date().toISOString().slice(0, 10),
    transports: transportsResult,
    notes: def.tested ? [] : ['first run of this read-back'],
  });
  const path = writeResult(root, result, [hostname(), userInfo().username, homedir()]);
  console.log(`wrote ${path}; run \`pnpm backends:table\` to update docs/backends.md`);
}

await main();
