// Fails when a dependency in the lockfile, dev dependencies included, has a license outside the allowlist. Reads
// `pnpm licenses list --json`, or the file given as the first argument (for tests). pnpm lists optional dependencies
// for the current platform only, so CI on Linux checks other native packages than a run on macOS.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// OSI-approved licenses seen in the lockfile. A license outside this list needs a review before it is added.
const allowed = new Set([
  '0BSD',
  'AFL-2.1',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  // Weak copyleft, file-level; only the dev dependency lightningcss uses it today.
  'MPL-2.0',
]);
// SPDX exceptions accepted after `WITH`; an exception outside this list, or one that is not an SPDX exception at
// all, makes the expression unacceptable until it is reviewed.
const allowedExceptions = new Set(['LLVM-exception']);

/**
 * Whether an SPDX license expression is acceptable: `OR` needs one allowed operand, `AND` needs all of them, and
 * `WITH` an allowed exception keeps the license it extends. Anything that does not parse, such as `Unknown` or
 * `SEE LICENSE IN ...`, and any exception outside the allowlist, is not acceptable.
 */
const isAllowed = (expression) => {
  const tokens = String(expression).match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = () => {
    throw new Error('unparsable');
  };
  const or = () => {
    let ok = and();
    while (tokens[at] === 'OR') {
      at++;
      ok = and() || ok;
    }
    return ok;
  };
  const and = () => {
    let ok = term();
    while (tokens[at] === 'AND') {
      at++;
      ok = term() && ok;
    }
    return ok;
  };
  const term = () => {
    const token = tokens[at++];
    if (token === '(') {
      const ok = or();
      if (tokens[at++] !== ')') fail();
      return ok;
    }
    if (token === undefined || ['(', ')', 'AND', 'OR', 'WITH'].includes(token)) fail();
    let exceptionOk = true;
    if (tokens[at] === 'WITH') {
      at++;
      const exception = tokens[at++] ?? '';
      if (!/^[A-Za-z0-9.-]+$/.test(exception)) fail();
      exceptionOk = allowedExceptions.has(exception);
    }
    return allowed.has(token) && exceptionOk;
  };
  try {
    const ok = or();
    return at === tokens.length && ok;
  } catch {
    return false;
  }
};

const json = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : execFileSync('pnpm', ['licenses', 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
const rejected = [];
for (const [license, packages] of Object.entries(JSON.parse(json))) {
  if (isAllowed(license)) continue;
  for (const { name, versions } of packages)
    rejected.push(`${name}@${versions.join(', ')}: ${license}`);
}
if (rejected.length > 0) {
  console.error(
    `Licenses outside the allowlist in scripts/check-licenses.mjs:\n  ${rejected.join('\n  ')}`,
  );
  process.exit(1);
}
console.log('Every dependency license is on the allowlist.');
