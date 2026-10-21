// Result files: docs/nodes/results/<node>@<version>.json, one per node and version, from which the tables of
// docs/nodes.md are generated. They hold the rows of diff.mjs, the genesis parameters and the setup, never a hash,
// key, raw transaction or time of the run, and no host data (the check of the backend matrix,
// scripts/backends/result.mjs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostDataProblems } from '../backends/result.mjs';

/** Version of the result format. */
export const SCHEMA = 1;

/** Directory of the result files, relative to the repository root. */
export const RESULTS_DIR = 'docs/nodes/results';

const NAME = /^[a-z0-9][a-z0-9.-]*$/;

/** File name of a node's result at a version. */
export function resultFile(node, version) {
  if (!NAME.test(node) || !NAME.test(String(version))) {
    throw new Error('a node and a version are lower-case letters, digits, dots and dashes');
  }
  return `${node}@${version}.json`;
}

/** Builds a result; `runDate` is a date only. */
export function buildResult({
  harness,
  spec,
  node,
  runDate,
  genesis,
  setup = [],
  probes,
  flows,
  chainModes = [],
  notes = [],
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error('runDate is a date (YYYY-MM-DD)');
  return {
    schema: SCHEMA,
    harness,
    spec,
    node,
    runDate,
    genesis,
    setup,
    probes,
    flows,
    chainModes,
    notes,
  };
}

const LONG_HEX = /0x[0-9a-fA-F]{64,}/;
const UNIX_TIME = /(?<![0-9a-fA-Fx])1[6-9]\d{8}(?!\d)/;
const WORD = /\bbugs?\b/i;

/**
 * What in a result's text must not be published: host data (a path, an address other than 127.0.0.1, a time of day,
 * one of `extra`), a hash, key or raw transaction (32 bytes of hex or more), a Unix time of the run, or the word bug
 * (results describe what was returned or stored). Empty when there is none.
 */
export function resultProblems(text, extra = []) {
  // 0.0.0.0 is the address a Docker node binds inside its container (its port is published on 127.0.0.1 only), as
  // the recorded start command shows; it names no host.
  const problems = hostDataProblems(text, extra).filter((p) => p !== 'the address 0.0.0.0');
  if (LONG_HEX.test(text)) problems.push('a hash, key or raw transaction');
  if (UNIX_TIME.test(text)) problems.push('a Unix time');
  if (WORD.test(text)) problems.push('the word bug');
  return problems;
}

/** The text of a result file: two-space JSON with a final newline. */
export const resultText = (result) => `${JSON.stringify(result, null, 2)}\n`;

/** Writes a result after checking it into `dir` (the results directory by default); returns the path written. */
export function writeResult(root, result, extra = [], dir = join(root, RESULTS_DIR)) {
  const text = resultText(result);
  const problems = resultProblems(text, extra);
  if (problems.length) throw new Error(`result not written, it holds ${problems.join(', ')}`);
  const path = join(dir, resultFile(result.node.name, result.node.version));
  writeFileSync(path, text);
  return path;
}
