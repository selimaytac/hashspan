// Result files: docs/backends/results/<backend>@<version>.json, one per backend and version, from which the
// Compatibility table in docs/backends.md is generated. They hold the normalised diff only, never the raw read-back,
// and no host data: no paths, host or user names, addresses other than 127.0.0.1, or times beyond the run date.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffMetrics, diffSpans, exercised, groupDifferences } from './diff.mjs';

/** Version of the result format. */
export const SCHEMA = 1;

/** Directory of the result files, relative to the repository root. */
export const RESULTS_DIR = 'docs/backends/results';

/** File name of a backend version's result. */
export const resultFile = (backend, version) => `${backend}@${version}.json`;

/** The trace part of a result for one transport. */
export function traceResult(expected, received, status) {
  const { summary, differences } = diffSpans(expected, received);
  return {
    ...(status === undefined ? {} : { status }),
    summary,
    exercised: exercised(expected, received),
    differences: groupDifferences(differences),
  };
}

/**
 * The metric part of a result for one transport: `got` is undefined when the backend's metrics were not read, and
 * `note` says why.
 */
export function metricResult(expected, got, { status, note } = {}) {
  const base = {
    ...(status === undefined ? {} : { status }),
    ...(note === undefined ? {} : { note }),
  };
  if (got === undefined) return { ...base, read: false };
  return { ...base, read: true, ...diffMetrics(expected, got) };
}

/**
 * Builds a result. `transports` maps a transport (`http/protobuf`, `http/json`) to `{ traces, metrics }` from
 * traceResult and metricResult.
 */
export function buildResult({ corpus, harness, backend, runDate, transports, notes = [] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error('runDate is a date (YYYY-MM-DD)');
  return { schema: SCHEMA, corpus, harness, backend, runDate, transports, notes };
}

const PATHS =
  /(?:^|[\s"'(=])(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * What in a result's text could identify the host: a path, an IPv4 address other than 127.0.0.1, a time of day, or one
 * of `extra` (the host and user name and home directory of the run). Empty when there is none.
 */
export function hostDataProblems(text, extra = []) {
  const problems = [];
  if (PATHS.test(text)) problems.push('a file path');
  for (const ip of text.match(IPV4) ?? []) {
    // A version such as 1.2.3.4 cannot be told from an address; the results name none.
    if (ip !== '127.0.0.1') problems.push(`the address ${ip}`);
  }
  if (DATETIME.test(text)) problems.push('a time of day');
  for (const value of extra) {
    if (value && value.length > 2 && text.includes(value)) problems.push('a host value');
  }
  return problems;
}

/** The text of a result file: two-space JSON, as Biome formats it, with a final newline. */
export const resultText = (result) => `${JSON.stringify(result, null, 2)}\n`;

/** Writes a result after checking it for host data; returns the path relative to the repository root. */
export function writeResult(root, result, extra = []) {
  const text = resultText(result);
  const problems = hostDataProblems(text, extra);
  if (problems.length) throw new Error(`result not written, it holds ${problems.join(', ')}`);
  const path = join(RESULTS_DIR, resultFile(result.backend.name, result.backend.version));
  writeFileSync(join(root, path), text);
  return path;
}
