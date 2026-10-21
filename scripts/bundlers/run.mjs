// Runs the ERC-4337 bundler matrix against one target: builds its image (Rundler from its checked release binary, Alto
// and Voltaire from a `git archive` of the pinned tag) and the faults-proxy image, starts e16-anvil on the e16-net
// network and sets the chain up (chain.mjs), probes the bundler (eth_chainId, eth_supportedEntryPoints first), runs the
// conformance pass (every case whose EntryPoint the target lists and the chain has, through the proxy with no fault)
// and the fault pass (each fault once, armed after the bundler is ready, on a fresh bundler), then writes
// docs/bundlers/results/<target>@<version>.json and removes the containers, the network and the images. Needs Docker,
// the network to build the images, the EntryPoint artifacts (./scripts/install-bundler.sh), and ports 18565 and 14337
// free on 127.0.0.1; run one target at a time, with other stacks stopped. No bundler ever runs on the host.
// Usage: node scripts/bundlers/run.mjs <target> [--pass conformance|faults|all] [--clone <dir>]
//                                     [--rundler-key <keyring>] [--keep-images]
//        node scripts/bundlers/run.mjs --list
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ARTIFACTS_DIR, fund, hasCode, senderOnChain, setupChain } from './chain.mjs';
import { eventsOf, rpc, runCase } from './conformance.mjs';
import {
  buildCase,
  CASES,
  CHAIN_ID,
  CORPUS_ID,
  corpusHash,
  ENTRY_POINTS,
  fundedSalts,
} from './corpus.mjs';
import {
  caseStatus,
  checkExpectations,
  checkInvariants,
  logTail,
  usableEntryPoints,
} from './diff.mjs';
import { FAULT_CASE, FAULT_SALT_BASE, FAULT_STEPS, faultScenarios } from './faults.mjs';
import { buildArchiveImage, buildFaultsImage, buildRundlerImage, scratch } from './images.mjs';
import { buildResult, resultFile, resultText, writeResult } from './result.mjs';
import {
  ANVIL,
  anvilArgs,
  bundlerArgs,
  bundlerUrl,
  containerOf,
  DOCKER_NETWORK,
  proxyArgs,
  receiptTimeoutOf,
  secretEnv,
  targets,
} from './targets.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const RPC_URL = `http://127.0.0.1:${ANVIL.hostPort}`;
const PROXY = containerOf('faults');
/** How long a bundler may take to answer after its start: Alto deploys its simulation contract first. */
const START_TIMEOUT_MS = 300_000;

/** Runs docker with an argument array; the bundler's keys come through the environment only. */
const docker = (args, env = {}) =>
  exec('docker', args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });

/** Polls until `probe` resolves true, or fails after `timeoutMs` with `what`. */
async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`not ready: ${what}`);
    await sleep(1000);
  }
}

/** The JSON lines the proxy runner printed. */
async function proxyLines() {
  const { stdout } = await docker(['logs', PROXY]);
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

/** Starts the proxy with a scenario (not armed yet) and the bundler behind it; returns when it lists EntryPoints. */
async function startPair(name, def, images, scenario) {
  await docker(proxyArgs(scenario, images.faults));
  let url;
  await waitFor(
    async () => {
      url = (await proxyLines()).find((l) => l.proxy)?.proxy;
      return url !== undefined;
    },
    30_000,
    'the faults proxy',
  );
  await docker(bundlerArgs(name, def, url, images.target), secretEnv(def));
  let listed;
  try {
    await waitFor(
      async () => {
        const { body } = await rpc(bundlerUrl(def), 'eth_supportedEntryPoints', [], 5000);
        listed = body?.result;
        return Array.isArray(listed);
      },
      START_TIMEOUT_MS,
      `${name} on ${bundlerUrl(def)}`,
    );
  } catch (error) {
    // The container is removed with --rm, so its last lines go into the error before they are gone.
    const logs = await docker(['logs', containerOf(name)]).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    const tail = logTail(`${logs.stdout}\n${logs.stderr}`);
    throw new Error(
      `${error.message}${tail ? `\nlast lines of ${containerOf(name)}:\n${tail}` : ''}`,
    );
  }
  return listed;
}

/** Applies the proxy's rules, now that the bundler is ready. */
async function arm() {
  await docker(['kill', '--signal', 'SIGUSR2', PROXY]);
  await waitFor(async () => (await proxyLines()).some((l) => l.armed), 10_000, 'the armed proxy');
}

/** Reads the proxy's request counts, then stops the bundler and the proxy. */
async function stopPair(name) {
  await sleep(500);
  const last = (await proxyLines()).filter((l) => l.requests).at(-1) ?? {};
  await docker(['rm', '--force', containerOf(name)]).catch(() => {});
  await docker(['rm', '--force', PROXY]).catch(() => {});
  const total = Object.values(last.requests ?? {}).reduce((a, b) => a + b, 0);
  return { total, sinceArmed: last.sinceArmed ?? {} };
}

/** The version names of a list of EntryPoint addresses, `other` for one the corpus does not know. */
const versionsOf = (addresses) =>
  (Array.isArray(addresses) ? addresses : []).map(
    (a) =>
      Object.entries(ENTRY_POINTS).find(
        ([, e]) => e.toLowerCase() === String(a).toLowerCase(),
      )?.[0] ?? 'other',
  );

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const [name, def] of Object.entries(targets)) {
      console.log(name, `wave ${def.wave}`, def.notYetRun ? `not run: ${def.note}` : def.version);
    }
    return;
  }
  const valued = ['--pass', '--clone', '--rundler-key'];
  const name = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  const def = targets[name];
  if (!def) throw new Error(`unknown target; one of ${Object.keys(targets).join(', ')}`);
  if (def.notYetRun) throw new Error(`${name} is not run by the matrix: ${def.note}`);
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const pass = option('--pass') ?? 'all';
  if (!['conformance', 'faults', 'all'].includes(pass))
    throw new Error('--pass is conformance, faults or all');
  const artifactsDir = join(root, ARTIFACTS_DIR);
  if (!existsSync(artifactsDir))
    throw new Error('run ./scripts/install-bundler.sh first: no EntryPoint artifacts');

  const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const harnessCommit = commit.trim();
  const images = {};
  const build = {};
  let anvilDigest = null;
  const conformance = [];
  const faults = [];
  const probes = {};
  let conformanceRequests = 0;
  let faultCasesWithoutRequests = 0;
  const ctx = {
    bundlerUrl: bundlerUrl(def),
    rpcUrl: RPC_URL,
    receiptTimeoutMs: receiptTimeoutOf(def),
  };
  try {
    if (def.build === 'release-binary') {
      const built = await buildRundlerImage(name, def, { keyring: option('--rundler-key') });
      images.target = built.image;
      Object.assign(build, { arch: built.arch, asset: built.asset, signature: built.signature });
    } else {
      const built = await buildArchiveImage(name, def, option('--clone'));
      images.target = built.image;
      if (built.submodules.length) build.submodules = built.submodules;
    }
    images.faults = await buildFaultsImage(root, harnessCommit);
    await docker(['pull', ANVIL.image]);
    anvilDigest = (
      await docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', ANVIL.image])
    ).stdout
      .trim()
      .split('@')[1];
    await docker(['network', 'create', DOCKER_NETWORK]);
    await docker(anvilArgs());
    await waitFor(
      async () => (await rpc(RPC_URL, 'eth_chainId', [], 5000)).body?.result !== undefined,
      60_000,
      'Anvil',
    );
    await setupChain(RPC_URL, { artifactsDir, fundedSalts: fundedSalts() });

    // eth_supportedEntryPoints first: a case whose EntryPoint the target does not list, or the chain does not have,
    // is `unsupported`, not a failure.
    const listed = await startPair(name, def, images, {});
    const chainId = (await rpc(ctx.bundlerUrl, 'eth_chainId', [])).body?.result;
    probes.chainId = chainId === undefined ? 'absent' : Number(chainId);
    probes.chainIdMatches = probes.chainId === CHAIN_ID;
    probes.supportedEntryPoints = versionsOf(listed);
    probes.usable = usableEntryPoints(listed, await hasCode(RPC_URL, listed), ENTRY_POINTS);
    if (pass !== 'faults') {
      for (const c of CASES) {
        const built = await buildCase(c);
        const status = caseStatus(built, probes.usable);
        if (status === 'unsupported') {
          conformance.push({ case: c.id, status, checks: [] });
          continue;
        }
        const observed = await runCase(built, ctx);
        conformance.push({
          case: c.id,
          status,
          observed,
          checks: checkExpectations(c.expect, observed),
        });
      }
    }
    conformanceRequests = (await stopPair(name)).total;
    // No egress is checked, not assumed: a bundler that sent nothing through the proxy used another node.
    if (conformanceRequests === 0) {
      throw new Error(
        `${name} sent no request through the faults proxy: its node is not the one the run set`,
      );
    }

    if (pass !== 'conformance' && probes.usable.includes('0.7')) {
      const c = CASES.find((x) => x.id === FAULT_CASE);
      const scenarios = faultScenarios();
      for (const [k, scenario] of scenarios.entries()) {
        const saltOffset = FAULT_SALT_BASE + k;
        const built = await buildCase(c, {
          senderOf: (salt) => senderOnChain(RPC_URL, salt),
          saltOffset,
        });
        for (const op of Object.values(built.ops)) await fund(RPC_URL, op.userOperation.sender);
        await startPair(name, def, images, scenario.rules);
        await arm();
        const observed = await runCase(
          { ...built, steps: FAULT_STEPS.map((call) => ({ call, op: 'main' })) },
          ctx,
        );
        const counts = await stopPair(name);
        if (counts.total === 0) faultCasesWithoutRequests++;
        faults.push({
          case: c.id,
          scenario: scenario.id,
          exercised: (counts.sinceArmed[scenario.method] ?? 0) >= 1,
          observed,
          built,
        });
      }
      // An operation that was included after its case ended (a bundle sent by a stopped bundler) counts for its case.
      for (const f of faults) {
        const afterPass = await eventsOf(f.built, RPC_URL);
        f.observed.effect.afterPass = afterPass;
        f.invariants = checkInvariants(f.observed, { afterPass, exercised: f.exercised });
        delete f.built;
      }
      if (faultCasesWithoutRequests > 0) {
        throw new Error(
          `${faultCasesWithoutRequests} fault cases saw no request through the faults proxy`,
        );
      }
    }
  } finally {
    // A failed removal is reported, so nothing of the run stays behind unnoticed.
    const remove = (what) =>
      docker(what).catch((e) =>
        console.error(`could not run docker ${what.join(' ')}: ${String(e?.stderr ?? e).trim()}`),
      );
    await remove(['rm', '--force', containerOf(name), PROXY, containerOf('anvil')]);
    await remove(['network', 'rm', DOCKER_NETWORK]);
    if (!args.includes('--keep-images')) {
      for (const image of [images.target, images.faults, ANVIL.image].filter(Boolean)) {
        await remove(['image', 'rm', image]);
      }
    }
  }

  const result = buildResult({
    corpus: { id: CORPUS_ID, sha256: corpusHash(root) },
    harness: { commit: harnessCommit },
    target: {
      name,
      title: def.title,
      repo: def.repo,
      version: def.version,
      commit: def.commit,
      build: { kind: def.build, ...build },
      unsafe: def.unsafe,
      listen: def.listen,
      bundleInterval: def.bundleInterval,
      receiptTimeoutMs: receiptTimeoutOf(def),
      start: { ...def.start, verified: true },
    },
    anvil: { image: ANVIL.image, digest: anvilDigest ?? null, chainId: CHAIN_ID },
    runDate: new Date().toISOString().slice(0, 10),
    probes,
    egress: { conformanceRequests, faultCasesWithoutRequests },
    conformance,
    faults,
    notes: [],
  });
  let path;
  try {
    path = writeResult(root, result, [hostname(), userInfo().username, homedir()]);
  } catch (error) {
    // Kept outside the repository, so a long run is not lost to one value that must not be published.
    const kept = join(scratch('result'), resultFile(name, def.version));
    writeFileSync(kept, resultText(result));
    throw new Error(`${error.message}; the run's result is in ${kept}, outside the repository`);
  }
  console.log(`wrote ${path}; run \`pnpm bundlers:table\` to update docs/bundlers.md`);
}

await main();
