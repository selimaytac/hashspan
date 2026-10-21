// Result files: docs/bundlers/results/<target>@<version>.json, one per target and pinned version, from which the
// tables of docs/bundlers.md are generated. They hold what each bundler answered, reduced by diff.mjs, never an
// operation, a signature, a hash or revert bytes, and no host data (the check of the backend matrix,
// scripts/backends/result.mjs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostDataProblems } from '../backends/result.mjs';

/** Version of the result format. */
export const SCHEMA = 1;

/** Directory of the result files, relative to the repository root. */
export const RESULTS_DIR = 'docs/bundlers/results';

/** File name of a target's result at a version. */
export const resultFile = (target, version) => `${target}@${version}.json`;

/** Builds a result; `runDate` is a date only. */
export function buildResult({
  corpus,
  harness,
  target,
  anvil,
  runDate,
  probes,
  egress,
  conformance,
  faults,
  notes = [],
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error('runDate is a date (YYYY-MM-DD)');
  return {
    schema: SCHEMA,
    corpus,
    harness,
    target,
    anvil,
    runDate,
    probes,
    egress,
    conformance,
    faults,
    notes,
  };
}

/** 32 bytes of hex or more: a hash, a signature, calldata or revert bytes. Commit ids (20 bytes) are allowed. */
const PAYLOAD = /0x[0-9a-fA-F]{64}/;
const WORD = /\bbugs?\b/i;

/**
 * What in a result's text must not be published: host data (a path, an address other than 127.0.0.1, a time of day,
 * one of `extra`), a hash or payload (32 bytes of hex or more), or the word bug (results describe what was returned or
 * stored). Empty when there is none.
 */
export function resultProblems(text, extra = []) {
  const problems = hostDataProblems(text, extra);
  if (PAYLOAD.test(text)) problems.push('a hash or payload');
  if (WORD.test(text)) problems.push('the word bug');
  return problems;
}

/** The text of a result file: two-space JSON with a final newline. */
export const resultText = (result) => `${JSON.stringify(result, null, 2)}\n`;

/** Writes a result after checking it; returns the path relative to the repository root. */
export function writeResult(root, result, extra = []) {
  const text = resultText(result);
  const problems = resultProblems(text, extra);
  if (problems.length) throw new Error(`result not written, it holds ${problems.join(', ')}`);
  const path = join(RESULTS_DIR, resultFile(result.target.name, result.target.version));
  writeFileSync(join(root, path), text);
  return path;
}
