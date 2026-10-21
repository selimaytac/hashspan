// Builds the images of a run from scratch build contexts, never from a bind mount: a target's image from a
// `git archive` of the pinned x402 commit with the target's Dockerfile (docker/), and the faults-proxy runner's image
// from the built packages/faults (package.json and dist/) with faults-runner/. Environment files of the archive are
// removed unread before the build.
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { imageOf } from './targets.mjs';

const run = promisify(execFile);
const here = new URL('./', import.meta.url).pathname;

/** A new, empty scratch directory; the caller removes it. */
export const scratch = (name) => mkdtempSync(join(tmpdir(), `e14-${name}-`));

/** Clones x402 without a checkout into `dir`, for `git archive`. Needs the network, at build time only. */
export async function cloneX402(repo, dir) {
  await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', repo, dir]);
}

/** Runs `git archive <commit> <paths>` of a clone and extracts it into `dest`. */
export async function archive(clone, commit, paths, dest) {
  await run('git', ['-C', clone, 'cat-file', '-e', `${commit}^{commit}`]).catch(() => {
    throw new Error(`the x402 clone lacks commit ${commit}; fetch it first`);
  });
  await new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', clone, 'archive', '--format=tar', commit, ...paths], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'inherit', 'inherit'] });
    git.stdout.pipe(tar.stdin);
    let open = 2;
    const done = (name) => (code) => {
      if (code !== 0) reject(new Error(`${name} exited with ${code}`));
      else if (--open === 0) resolve();
    };
    git.on('exit', done('git archive'));
    tar.on('exit', done('tar'));
  });
  removeEnvFiles(dest);
}

/** Removes every `.env*` file under `dir` without reading it, so no image carries one. */
function removeEnvFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeEnvFiles(path);
    else if (entry.name.startsWith('.env')) rmSync(path);
  }
}

/** Builds `image` from a context directory with one of the Dockerfiles of docker/. */
async function build(context, dockerfile, image) {
  cpSync(join(here, 'docker', dockerfile), join(context, 'hashspan.Dockerfile'));
  await run(
    'docker',
    ['build', '--file', join(context, 'hashspan.Dockerfile'), '--tag', image, context],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/** Builds a target's image from the x402 clone; returns its tag. */
export async function buildTargetImage(name, def, clone) {
  const context = scratch(name);
  try {
    await archive(clone, def.commit, def.archive, context);
    const image = imageOf(name, def.commit);
    await build(context, def.dockerfile, image);
    return image;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** Builds the faults-proxy runner's image from packages/faults, which `pnpm build` must have built; returns its tag. */
export async function buildFaultsImage(root, commit) {
  const faults = join(root, 'packages/faults');
  if (!existsSync(join(faults, 'dist/index.mjs'))) {
    throw new Error(
      'packages/faults is not built: run `pnpm --filter @hashspan/faults build` first',
    );
  }
  const context = scratch('faults');
  try {
    const target = join(context, 'node_modules/@hashspan/faults');
    mkdirSync(target, { recursive: true });
    cpSync(join(faults, 'package.json'), join(target, 'package.json'));
    cpSync(join(faults, 'dist'), join(target, 'dist'), { recursive: true });
    for (const file of ['runner.mjs', 'scenario.mjs']) {
      cpSync(join(here, 'faults-runner', file), join(context, file));
    }
    const image = imageOf('faults', commit);
    await build(context, 'faults.Dockerfile', image);
    return image;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}
