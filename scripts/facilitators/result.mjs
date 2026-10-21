// Result files: docs/facilitators/results/<target>@<commit>.json, one per target and pinned commit, from which the
// tables of docs/facilitators.md are generated. They hold what each facilitator answered, reduced by diff.mjs, never a
// payload or a signature, and no host data (the check of the backend matrix, scripts/backends/result.mjs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostDataProblems } from '../backends/result.mjs';

/** Version of the result format. */
export const SCHEMA = 1;

/** Directory of the result files, relative to the repository root. */
export const RESULTS_DIR = 'docs/facilitators/results';

/** File name of a target's result at a commit: the target and the commit's first eight characters. */
export const resultFile = (target, commit) => `${target}@${String(commit).slice(0, 8)}.json`;

/** Builds a result; `runDate` is a date only. */
export function buildResult({
  corpus,
  harness,
  target,
  anvil,
  runDate,
  supported,
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
    supported,
    egress,
    conformance,
    faults,
    notes,
  };
}

const SIGNATURE = /0x[0-9a-fA-F]{130}/;
const WORD = /\bbugs?\b/i;

/**
 * What in a result's text must not be published: host data (a path, an address other than 127.0.0.1, a time of day,
 * one of `extra`), a signature or payload (65 bytes of hex or more), or the word bug (results describe what was
 * returned or stored). Empty when there is none.
 */
export function resultProblems(text, extra = []) {
  const problems = hostDataProblems(text, extra);
  if (SIGNATURE.test(text)) problems.push('a signature or payload');
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
  const path = join(RESULTS_DIR, resultFile(result.target.name, result.target.commit));
  writeFileSync(join(root, path), text);
  return path;
}
