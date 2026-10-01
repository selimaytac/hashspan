// Publishes the pending releases one dependency layer at a time, and waits until each layer's new versions are
// visible on the registry before publishing the packages that depend on them. `changeset publish` already publishes
// the layers in order, but the registry makes versions visible minutes later and in any order: in 0.4.0, core became
// visible after the adapters that require it, and installing them failed meanwhile (issue #117).
//
// Each layer goes through `changeset pack` and `changeset publish --from-pack-dir` with a plan of that layer only.
// Both append to the report file in CHANGESETS_OUTPUT, from which changesets/action creates the git tags and GitHub
// releases, as it does for a single `changeset publish`. After the last layer, every published version is installed
// from the registry into an empty project and imported, so a release that cannot be installed fails the job.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VISIBLE_TIMEOUT_MS = Number(process.env.PUBLISH_VISIBLE_TIMEOUT_MS ?? 15 * 60 * 1000);
const POLL_MS = 10_000;

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });

/** True once `name@version` resolves on the configured registry. */
function isVisible(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out) === version;
  } catch {
    return false;
  }
}

async function waitUntilVisible(releases) {
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
  for (const { name, version } of releases) {
    while (!isVisible(name, version)) {
      if (Date.now() > deadline) {
        throw new Error(
          `${name}@${version} is still not visible on the registry; not publishing its dependents`,
        );
      }
      console.log(`Waiting for ${name}@${version} to be visible on the registry...`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    console.log(`${name}@${version} is visible on the registry.`);
  }
}

/** Installs every published version into an empty project and imports it, as a user would. */
function checkInstall(releases) {
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
}

const work = mkdtempSync(join(tmpdir(), 'hashspan-publish-'));
try {
  const planFile = join(work, 'plan.json');
  run('pnpm', ['changeset', 'publish-plan', '--output', planFile]);
  const { version, plan } = JSON.parse(readFileSync(planFile, 'utf8'));
  const published = [];
  for (const [index, layer] of plan.entries()) {
    const layerPlan = join(work, `plan-${index}.json`);
    const packDir = join(work, `pack-${index}`);
    writeFileSync(layerPlan, JSON.stringify({ version, plan: [layer] }));
    run('pnpm', ['changeset', 'pack', '--from-publish-plan', layerPlan, '--out-dir', packDir]);
    run('pnpm', ['changeset', 'publish', '--from-pack-dir', packDir]);
    const releases = layer.filter((release) => release.kind === 'publish');
    published.push(...releases);
    // The next layer requires this one; the last layer is checked by the install below.
    if (index < plan.length - 1) await waitUntilVisible(releases);
  }
  if (published.length > 0) {
    await waitUntilVisible(published);
    checkInstall(published);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
