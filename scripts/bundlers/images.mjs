// Builds the images of a run from scratch build contexts, never from a bind mount: Rundler's from its checked release
// binary (rundler.mjs), Alto's and Voltaire's from a `git archive` of the pinned tag commit (Alto with each
// contracts/lib submodule fetched at the commit the tag records), and the faults-proxy runner's from the built
// packages/faults. Environment files of an archive are removed unread before the build. Building needs the network;
// running does not.
import { execFile, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { downloadRundler, RUNDLER_RELEASE, rundlerArch, verifyWithKey } from './rundler.mjs';
import { imageOf } from './targets.mjs';

const run = promisify(execFile);
const here = new URL('./', import.meta.url).pathname;

/** A new, empty scratch directory; the caller removes it. */
export const scratch = (name) => mkdtempSync(join(tmpdir(), `e16-${name}-`));

/** The architecture of the Docker VM, which the images run on (not the host's). */
export async function dockerArch() {
  const { stdout } = await run('docker', ['info', '--format', '{{.Architecture}}']);
  return stdout.trim();
}

/** Clones a repository without a checkout into `dir`, for `git archive`. */
export async function clone(repo, dir) {
  await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', repo, dir]);
}

/** Pipes `git archive <commit> [paths]` of a repository into `tar -x` in `dest`. */
function extract(repoDir, commit, paths, dest) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', repoDir, 'archive', '--format=tar', commit, ...paths], {
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
}

/** Removes every `.env*` file under `dir` without reading it, so no image carries one. */
function removeEnvFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeEnvFiles(path);
    else if (entry.name.startsWith('.env')) rmSync(path);
  }
}

/** `git archive` of `paths` at `commit` of a clone, into `dest`. */
export async function archive(repoDir, commit, paths, dest) {
  await run('git', ['-C', repoDir, 'cat-file', '-e', `${commit}^{commit}`]).catch(() => {
    throw new Error(`the clone lacks commit ${commit}; fetch it first`);
  });
  await extract(repoDir, commit, paths, dest);
  removeEnvFiles(dest);
}

/**
 * The submodules under `prefix` the commit records: their path and commit (`git ls-tree`, mode 160000), with the URL
 * the commit's .gitmodules gives each.
 */
export async function submodulesOf(repoDir, commit, prefix) {
  const { stdout: tree } = await run('git', ['-C', repoDir, 'ls-tree', commit, `${prefix}/`]);
  const { stdout: modules } = await run('git', ['-C', repoDir, 'show', `${commit}:.gitmodules`]);
  return parseSubmodules(tree, modules);
}

/** The gitlinks of `git ls-tree` output with their URL from a .gitmodules text. */
export function parseSubmodules(tree, gitmodules) {
  const urls = {};
  let path;
  for (const line of gitmodules.split('\n')) {
    const p = /^\s*path\s*=\s*(\S+)/.exec(line);
    if (p) path = p[1];
    const u = /^\s*url\s*=\s*(\S+)/.exec(line);
    if (u && path) urls[path] = u[1];
  }
  return tree
    .split('\n')
    .map((line) => /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line))
    .filter(Boolean)
    .map(([, commit, path]) => {
      if (!urls[path]) throw new Error(`no URL for submodule ${path}`);
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(urls[path].replace(/\.git$/, ''))) {
        throw new Error(`submodule ${path} is not a GitHub https URL`);
      }
      return { path, commit, url: urls[path] };
    });
}

/** Fetches one commit of a repository and extracts its tree into `dest`. */
async function fetchTree(url, commit, dest) {
  const dir = scratch('module');
  try {
    await run('git', ['init', '--quiet', dir]);
    await run('git', ['-C', dir, 'fetch', '--quiet', '--depth', '1', url, commit]);
    mkdirSync(dest, { recursive: true });
    await extract(dir, commit, [], dest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

/**
 * Builds Rundler's image from the checked release binary for the Docker VM's architecture. With `keyring`, gpgv also
 * verifies the signature; returns the tag and how the signature was checked.
 */
export async function buildRundlerImage(name, def, { keyring } = {}) {
  const arch = rundlerArch(await dockerArch());
  const context = scratch(name);
  try {
    const { asset, archive: bytes, asc, signature } = await downloadRundler(arch);
    const tarball = join(context, asset.name);
    writeFileSync(tarball, bytes);
    if (keyring) {
      writeFileSync(`${tarball}.asc`, asc);
      await verifyWithKey(keyring, `${tarball}.asc`, tarball);
      signature.verified = true;
    }
    await run('tar', ['-x', '-z', '-f', tarball, '-C', context, 'rundler']);
    rmSync(tarball);
    rmSync(`${tarball}.asc`, { force: true });
    const image = imageOf(name, def.commit);
    await build(context, def.dockerfile, image);
    return { image, arch, asset: asset.name, signature };
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** Builds Alto's or Voltaire's image from a clone of its repository (`repoDir`, or a fresh one). */
export async function buildArchiveImage(name, def, repoDir) {
  const context = scratch(name);
  const own = !repoDir;
  const dir = repoDir ?? scratch(`${name}-clone`);
  try {
    if (own) await clone(def.repo, dir);
    await archive(dir, def.commit, def.archive, context);
    const modules = [];
    if (def.submodules) {
      for (const m of await submodulesOf(dir, def.commit, def.submodules)) {
        await fetchTree(m.url, m.commit, join(context, m.path));
        modules.push({ path: m.path, commit: m.commit });
      }
      removeEnvFiles(context);
    }
    const image = imageOf(name, def.commit);
    await build(context, def.dockerfile, image);
    return { image, submodules: modules };
  } finally {
    rmSync(context, { recursive: true, force: true });
    if (own) rmSync(dir, { recursive: true, force: true });
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
    cpSync(join(here, 'faults-runner/runner.mjs'), join(context, 'runner.mjs'));
    cpSync(join(here, '../facilitators/faults-runner/scenario.mjs'), join(context, 'scenario.mjs'));
    const image = imageOf('faults', commit);
    await build(context, 'faults.Dockerfile', image);
    return image;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

export { RUNDLER_RELEASE };
