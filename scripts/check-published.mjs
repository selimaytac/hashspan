// Installs the versions a release just published from the registry into an empty project and imports each, as a user
// would, so a release that cannot be installed fails the workflow. Runs in the Release workflow's `check` job, after
// `publish`, with read-only permissions: installing and importing runs the code of every dependency, which must not
// happen in the job that can publish.
//
// PUBLISHED_PACKAGES is the `published-packages` output of changesets/action: [{"name": "@hashspan/core", ...}].
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAME = /^@hashspan\/[a-z0-9-]+$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const releases = JSON.parse(process.env.PUBLISHED_PACKAGES ?? '[]');
if (!Array.isArray(releases) || releases.length === 0) {
  throw new Error('PUBLISHED_PACKAGES lists no packages');
}
for (const { name, version } of releases) {
  if (!NAME.test(name) || !VERSION.test(version)) {
    throw new Error(`unexpected published package: ${JSON.stringify({ name, version })}`);
  }
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });

const project = mkdtempSync(join(tmpdir(), 'hashspan-install-'));
try {
  writeFileSync(join(project, 'package.json'), '{"private":true,"type":"module"}\n');
  run(
    'npm',
    ['install', '--no-audit', '--no-fund', ...releases.map((r) => `${r.name}@${r.version}`)],
    {
      cwd: project,
    },
  );
  for (const { name } of releases) {
    run('node', ['--input-type=module', '-e', `await import(${JSON.stringify(name)})`], {
      cwd: project,
    });
    console.log(`${name} installs and imports.`);
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}
