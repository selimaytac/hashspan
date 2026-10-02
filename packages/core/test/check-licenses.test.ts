// Tests scripts/check-licenses.mjs, which CI runs over the lockfile, with `pnpm licenses list --json` output written
// to a temporary file.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/check-licenses.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'hashspan-licenses-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the script over a listing with one package per license. */
const check = (...licenses: string[]): Promise<{ code: number; stderr: string }> => {
  const listing = Object.fromEntries(
    licenses.map((license, i) => [license, [{ name: `pkg-${i}`, versions: ['1.0.0'] }]]),
  );
  const file = join(dir, `${licenses.length}-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(listing));
  return new Promise((resolve) => {
    execFile(process.execPath, [script, file], (error, _out, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stderr });
    });
  });
};

describe('check-licenses script', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    'MIT OR Apache-2.0',
    '(AFL-2.1 OR BSD-3-Clause)',
    'MIT AND ISC',
    'GPL-3.0 OR MIT',
    'Apache-2.0 WITH LLVM-exception',
    '(MIT OR GPL-3.0) AND (ISC OR BSD-2-Clause)',
  ])('accepts %s', async (license) => {
    expect(await check(license)).toEqual({ code: 0, stderr: '' });
  });

  it.each([
    'GPL-3.0',
    'MIT AND GPL-3.0',
    'Unknown',
    'SEE LICENSE IN LICENSE.md',
    'MIT OR',
    '(MIT',
    'MIT)',
    'MIT Apache-2.0',
    'MIT WITH',
    '',
  ])('rejects %j and names the package', async (license) => {
    const { code, stderr } = await check('MIT', license);
    expect(code).toBe(1);
    expect(stderr).toContain(`pkg-1@1.0.0: ${license}`);
    expect(stderr).not.toContain('pkg-0');
  });
});
