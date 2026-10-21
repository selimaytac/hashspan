// Runs the dev-node matrix against one node: starts it fresh, reads its genesis parameters, probes what it offers,
// funds the well-known accounts where it does not (Geth), runs the flows, then each of its chain modes on a fresh node
// of its own, and writes docs/nodes/results/<node>@<version>.json. Anvil and Hardhat run as local processes on
// 127.0.0.1:18555; Reth and Geth in Docker (targets.mjs). Everything the run downloads or creates (the Anvil archive,
// the Hardhat project, the container, Reth's volume, the image) is removed at the end. Run one node at a time, with
// other stacks stopped and port 18555 free.
// Usage: node scripts/nodes/run.mjs <node> [--anvil <binary>] [--nightly <tag>] [--no-chain-modes] [--out <dir>]
//                                          [--keep-image]
//        node scripts/nodes/run.mjs --list
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { modesOf } from './chain-modes.mjs';
import { accountAt, FUNDING, ROLES, runFlows } from './flows.mjs';
import { probe } from './probes.mjs';
import { buildResult, resultFile, resultText, writeResult } from './result.mjs';
import { client, sanitize } from './rpc.mjs';
import { loadSpec } from './schemas.mjs';
import { fundFromFaucet, genesisOf } from './setup.mjs';
import {
  ANVIL_RELEASE,
  anvilArgs,
  anvilVersion,
  checkArchive,
  containerOf,
  dockerArgs,
  foundryArchive,
  foundryPlatform,
  HARDHAT,
  HARDHAT_CONFIG,
  hardhatArgs,
  hardhatPackage,
  imageRef,
  nightlyDate,
  RPC_URL,
  targets,
  volumeOf,
} from './targets.mjs';
import { SOURCE } from './vendor.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const FOUNDRY = 'https://github.com/foundry-rs/foundry';
const FOUNDRY_API = 'https://api.github.com/repos/foundry-rs/foundry';

/** A new, empty scratch directory outside the repository; the run removes it. */
const scratch = (name) => mkdtempSync(join(tmpdir(), `e15-${name}-`));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Downloads Anvil of a Foundry release or nightly tag into `dir`, checks the archive against every checksum there is
 * (the pinned one for the release; the release's `.sha256` file and the digest its API lists, for both), extracts the
 * `anvil` binary and returns its path and the release's name.
 */
async function fetchAnvil(tag, dir) {
  const platform = foundryPlatform();
  if (!platform)
    throw new Error(`Foundry ships no archive for ${process.platform}/${process.arch}`);
  const archive = foundryArchive(tag, platform);
  const release = await (await fetch(`${FOUNDRY_API}/releases/tags/${tag}`)).json();
  const asset = (release.assets ?? []).find((a) => a.name === archive);
  const sums = (release.assets ?? []).find(
    (a) => a.name === archive.replace(/\.tar\.gz$/, '.sha256'),
  );
  const bytes = await download(`${FOUNDRY}/releases/download/${tag}/${archive}`);
  const file = sums
    ? (await download(`${FOUNDRY}/releases/download/${tag}/${sums.name}`)).toString()
    : undefined;
  checkArchive(createHash('sha256').update(bytes).digest('hex'), {
    pinned: tag === ANVIL_RELEASE.tag ? ANVIL_RELEASE.sha256[platform] : undefined,
    file,
    digest: asset?.digest,
  });
  const path = join(dir, archive);
  writeFileSync(path, bytes);
  await exec('tar', ['-xzf', path, '-C', dir, 'anvil']);
  return { binary: join(dir, 'anvil'), name: release.name };
}

/** Checks that a binary is the Anvil the row names; returns what `anvil --version` printed. */
async function checkAnvil(binary, { version, commit }) {
  const { stdout } = await exec(binary, ['--version']);
  const got = anvilVersion(stdout);
  if (commit && got.commit !== commit)
    throw new Error(`the Anvil binary is commit ${got.commit}, not ${commit}`);
  if (version && got.version !== version)
    throw new Error(`the Anvil binary is ${got.version}, not ${version}`);
  return got;
}

/** Installs Hardhat with the pinned EDR into `dir` (needs the npm registry) and checks both versions. */
async function installHardhat(dir) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(hardhatPackage(), null, 2)}\n`);
  writeFileSync(join(dir, 'hardhat.config.js'), HARDHAT_CONFIG);
  await exec(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'error'],
    {
      cwd: dir,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const version = (pkg) =>
    JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  if (version('hardhat') !== HARDHAT.version)
    throw new Error(`installed hardhat ${version('hardhat')}`);
  if (version('@nomicfoundation/edr') !== HARDHAT.edr) {
    throw new Error(
      `installed EDR ${version('@nomicfoundation/edr')}, not ${HARDHAT.edr}: the override did not apply`,
    );
  }
}

/** Starts a local process; returns a stop function. Its output is not kept, so no host detail reaches a result. */
function startProcess(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'], ...options });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  return {
    child,
    exited: () => exited,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

const docker = (args) => exec('docker', args, { maxBuffer: 16 * 1024 * 1024 });

/** Waits until the node answers eth_chainId. */
async function waitForNode(rpc, running, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await rpc.call('eth_chainId');
    if (answer.result) return;
    if (running?.exited?.()) throw new Error('the node exited before it answered');
    if (Date.now() > deadline) throw new Error(`the node did not answer on ${RPC_URL}`);
    await sleep(500);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const [name, def] of Object.entries(targets)) {
      console.log(name, def.status, def.version ?? '', def.note ?? '');
    }
    return;
  }
  const valued = ['--anvil', '--nightly', '--out'];
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const name = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  const def = targets[name];
  if (!def) throw new Error(`unknown node; one of ${Object.keys(targets).join(', ')}`);
  if (def.status !== 'run') throw new Error(`${name} is ${def.status}: ${def.note}`);
  if (name === 'anvil-nightly' && !option('--nightly')) {
    throw new Error('anvil-nightly needs --nightly <tag>, the tag of a Foundry nightly release');
  }

  const spec = loadSpec(root);
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const cleanup = [];
  const node = {
    name,
    title: def.title,
    version: def.version,
    source: def.source,
    known: def.known,
  };
  let start;
  let genesis;
  let probes;
  const setup = [];
  let flows;
  const chainModes = [];
  try {
    // How to start a fresh node of this target, with a chain mode's start options.
    if (def.runs === 'local' && name.startsWith('anvil')) {
      let binary = option('--anvil');
      if (name === 'anvil-nightly') {
        const tag = option('--nightly');
        const dir = scratch('anvil');
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const fetched = await fetchAnvil(tag, dir);
        binary = fetched.binary;
        const date = nightlyDate(fetched.name);
        if (!date) throw new Error('the nightly release names no date');
        node.version = date;
        node.tag = tag;
        node.commit = await checkAnvil(binary, { commit: tag.replace(/^nightly-/, '') }).then(
          (v) => v.commit,
        );
      } else {
        if (!binary) {
          const dir = scratch('anvil');
          cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
          binary = (await fetchAnvil(ANVIL_RELEASE.tag, dir)).binary;
        }
        await checkAnvil(binary, ANVIL_RELEASE);
        node.tag = ANVIL_RELEASE.tag;
        node.commit = ANVIL_RELEASE.commit;
      }
      start = (mode = {}) => startProcess(binary, anvilArgs(mode.args));
      node.start = { command: `anvil ${anvilArgs().join(' ')}`, verified: true };
    } else if (name === 'hardhat') {
      const dir = scratch('hardhat');
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      await installHardhat(dir);
      node.edr = HARDHAT.edr;
      start = (mode = {}) =>
        startProcess(join(dir, 'node_modules/.bin/hardhat'), hardhatArgs(mode.network), {
          cwd: dir,
          env: { ...process.env, HARDHAT_DISABLE_TELEMETRY: 'true' },
        });
      node.start = { command: `hardhat ${hardhatArgs().join(' ')}`, verified: true };
    } else {
      const image = imageRef(def);
      await docker(['pull', image]);
      if (!args.includes('--keep-image'))
        cleanup.push(() => docker(['image', 'rm', image]).catch(() => {}));
      const volume = volumeOf(name, def);
      start = () => {
        let stopped = false;
        const ready = (async () => {
          if (volume) await docker(['volume', 'create', volume.name]);
          await docker(dockerArgs(name, def));
        })();
        return {
          ready,
          exited: () => stopped,
          async stop() {
            stopped = true;
            await ready.catch(() => {});
            await docker(['rm', '--force', containerOf(name)]).catch(() => {});
            if (volume) await docker(['volume', 'rm', volume.name]).catch(() => {});
          },
        };
      };
      node.image = def.image;
      node.digest = def.digest;
      node.start = { command: `docker ${dockerArgs(name, def).join(' ')}`, verified: true };
    }

    const rpc = client(RPC_URL);
    const running = start();
    try {
      await running.ready;
      await waitForNode(rpc, running, 120_000);
      genesis = await genesisOf(rpc, accountAt(0).address);
      probes = await probe(rpc);
      if (def.fundsFromFaucet) {
        setup.push(
          await fundFromFaucet(
            rpc,
            Object.values(ROLES).map((i) => accountAt(i).address),
            FUNDING,
          ),
        );
      }
      const chainId = genesis.chainId;
      flows = await runFlows({ rpc, chainId, probes, node: def }, spec);
    } finally {
      await running.stop();
    }

    if (!args.includes('--no-chain-modes')) {
      for (const mode of modesOf(name.startsWith('anvil') ? 'anvil' : name)) {
        const fresh = start(mode.start);
        const entry = {
          flow: mode.id,
          mode: mode.mode,
          start: mode.start,
          reference: mode.reference,
          status: 'run',
          checks: [],
        };
        try {
          await fresh.ready;
          await waitForNode(rpc, fresh, 120_000);
          const id = await rpc.call('eth_chainId');
          await mode.run(
            { rpc, spec, chainId: Number(BigInt(id.result)), node: def },
            entry.checks,
          );
        } catch (error) {
          entry.status = 'failed';
          entry.error = sanitize(error?.shortMessage ?? error?.message ?? error);
        } finally {
          await fresh.stop();
        }
        chainModes.push(entry);
      }
    }
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }

  const result = buildResult({
    harness: { commit: head.trim() },
    spec: { repo: SOURCE.repo, commit: SOURCE.commit },
    node,
    runDate: new Date().toISOString().slice(0, 10),
    genesis,
    setup,
    probes,
    flows,
    chainModes,
  });
  const extra = [hostname(), userInfo().username, homedir()];
  const out = option('--out');
  try {
    const path = writeResult(root, result, extra, out);
    console.log(`wrote ${path}; run \`pnpm nodes:table\` to update docs/nodes.md`);
  } catch (error) {
    // Kept outside the repository, so a run is not lost to one value that must not be published.
    const kept = join(scratch('result'), resultFile(result.node.name, result.node.version));
    writeFileSync(kept, resultText(result));
    throw new Error(`${error.message}; the run's result is in ${kept}, outside the repository`);
  }
}

await main();
