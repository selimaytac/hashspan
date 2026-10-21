// Runs the facilitator conformance matrix against one target: builds its image from the pinned x402 commit and the
// faults-proxy image, starts e14-anvil on the e14-net network and sets the chain up, reads /supported, runs the
// conformance pass (every case and flow of a scheme the target offers, through the proxy with no fault) and the fault
// pass (each fault once, on a fresh facilitator), then writes docs/facilitators/results/<target>@<commit>.json and
// removes the containers, the network and the images. Needs Docker, the network to build the images, and ports
// 18545 and 14022 free on 127.0.0.1; run one target at a time, with other stacks stopped.
// Usage: node scripts/facilitators/run.mjs <target> [--x402 <clone>] [--pass conformance|faults|all] [--keep-images]
//        node scripts/facilitators/run.mjs --list
import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { balanceOf, setupChain } from './chain.mjs';
import { runCase, runFaultCase } from './conformance.mjs';
import { buildCase, CASES, CORPUS_ID, corpusHash, FLOWS, NETWORK, receiverOf } from './corpus.mjs';
import { caseStatus, checkExpectations, checkInvariants, supportedSchemes } from './diff.mjs';
import { FAULT_CASES, faultScenarios } from './faults.mjs';
import { runFlow } from './flows.mjs';
import { buildFaultsImage, buildTargetImage, cloneX402, scratch } from './images.mjs';
import { buildResult, resultFile, resultText, writeResult } from './result.mjs';
import {
  ANVIL,
  anvilArgs,
  containerOf,
  DOCKER_NETWORK,
  FACILITATOR_PORT,
  facilitatorArgs,
  proxyArgs,
  secretEnv,
  targets,
} from './targets.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const RPC_URL = `http://127.0.0.1:${ANVIL.hostPort}`;
const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT.host}`;
const PROXY = containerOf('faults');

/** Runs docker with an argument array; the facilitator key comes through the environment only. */
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

/** Starts the proxy with a scenario and the facilitator behind it; returns when /supported answers. */
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
  await docker(facilitatorArgs(name, def, url, images.target), secretEnv());
  let supported;
  await waitFor(
    async () => {
      const response = await fetch(`${FACILITATOR_URL}/supported`);
      if (!response.ok) return false;
      supported = await response.json();
      return true;
    },
    300_000,
    `${name} on ${FACILITATOR_URL}`,
  );
  return supported;
}

/** Reads the proxy's request count, then stops the facilitator and the proxy. */
async function stopPair(name) {
  await sleep(500);
  const counts = (await proxyLines()).filter((l) => l.requests).at(-1)?.requests ?? {};
  await docker(['rm', '--force', containerOf(name)]).catch(() => {});
  await docker(['rm', '--force', PROXY]).catch(() => {});
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const [name, def] of Object.entries(targets)) {
      console.log(name, `wave ${def.wave}`, def.notYetRun ? 'not yet run' : def.commit.slice(0, 8));
    }
    return;
  }
  const name = args.find(
    (a, i) => !a.startsWith('--') && !['--x402', '--pass'].includes(args[i - 1]),
  );
  const def = targets[name];
  if (!def) throw new Error(`unknown target; one of ${Object.keys(targets).join(', ')}`);
  if (def.notYetRun)
    throw new Error(`${name} is a wave-${def.wave} target, not yet run: ${def.note}`);
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const pass = option('--pass') ?? 'all';
  if (!['conformance', 'faults', 'all'].includes(pass))
    throw new Error('--pass is conformance, faults or all');

  const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const harnessCommit = commit.trim();
  const now = Math.floor(Date.now() / 1000);
  const cleanup = [];
  const images = {};
  let anvilDigest = null;
  const conformance = [];
  const faults = [];
  let supported;
  let conformanceRequests = 0;
  let faultCasesWithoutRequests = 0;
  try {
    let clone = option('--x402');
    if (!clone) {
      clone = scratch('x402');
      cleanup.push(() => rmSync(clone, { recursive: true, force: true }));
      await cloneX402(def.repo, clone);
    }
    images.target = await buildTargetImage(name, def, clone);
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
      async () => {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
        });
        return response.ok;
      },
      60_000,
      'Anvil',
    );
    await setupChain(RPC_URL);

    // /supported first: a scheme the target does not offer is `unsupported`, not a failure.
    supported = await startPair(name, def, images, {});
    const schemes = supportedSchemes(supported, NETWORK);
    if (pass !== 'faults') {
      for (const c of CASES) {
        const status = caseStatus(c, schemes);
        if (status === 'unsupported') {
          conformance.push({ case: c.id, status, checks: [] });
          continue;
        }
        const built = await buildCase(c, { now, salt: 'conformance' });
        const observed = await runCase(built, { facilitatorUrl: FACILITATOR_URL, rpcUrl: RPC_URL });
        conformance.push({
          case: c.id,
          status,
          observed,
          checks: checkExpectations(c.expect, observed),
        });
      }
      for (const flow of FLOWS) {
        const status = caseStatus(flow, schemes);
        if (status === 'unsupported') {
          conformance.push({ case: flow.id, status, checks: [] });
          continue;
        }
        const observed = await runFlow(flow, { facilitatorUrl: FACILITATOR_URL, rpcUrl: RPC_URL });
        conformance.push({
          case: flow.id,
          status,
          observed,
          checks: checkExpectations(flow.expect, observed),
        });
      }
    }
    conformanceRequests = await stopPair(name);
    // No egress is checked, not assumed: a facilitator that sent nothing through the proxy used another RPC.
    if (pass !== 'faults' && conformanceRequests === 0) {
      throw new Error(
        `${name} sent no request through the faults proxy: its RPC is not the one the run set`,
      );
    }

    if (pass !== 'conformance') {
      for (const id of FAULT_CASES) {
        const c = CASES.find((x) => x.id === id);
        if (caseStatus(c, schemes) === 'unsupported') continue;
        for (const scenario of faultScenarios()) {
          await startPair(name, def, images, scenario.rules);
          const salt = `${id}:${scenario.id}`;
          const built = await buildCase(c, {
            now: Math.floor(Date.now() / 1000),
            salt,
            payTo: receiverOf(salt),
          });
          const observed = await runFaultCase(built, {
            facilitatorUrl: FACILITATOR_URL,
            rpcUrl: RPC_URL,
          });
          const requests = await stopPair(name);
          if (requests === 0) faultCasesWithoutRequests++;
          faults.push({
            case: id,
            scenario: scenario.id,
            amount: c.settleAmount ?? '10000',
            salt,
            observed,
          });
        }
      }
      // A transfer that mined after its case ended (a queued send of a stopped facilitator) counts for its own case.
      for (const f of faults) {
        f.observed.effect.afterPass = await balanceOf(RPC_URL, receiverOf(f.salt));
        f.invariants = checkInvariants(f.observed, { amount: f.amount, known: def.known });
        delete f.salt;
        delete f.amount;
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
    for (const fn of cleanup) fn();
  }

  const result = buildResult({
    corpus: { id: CORPUS_ID, sha256: corpusHash(root) },
    harness: { commit: harnessCommit },
    target: {
      name,
      title: def.title,
      repo: def.repo,
      commit: def.commit,
      path: def.path,
      rpc: def.rpc,
      start: { ...def.start, verified: true },
    },
    anvil: {
      image: ANVIL.image,
      digest: anvilDigest ?? null,
      chainId: Number(NETWORK.split(':')[1]),
    },
    runDate: new Date().toISOString().slice(0, 10),
    supported: [...supportedSchemes(supported, NETWORK)].sort(),
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
    const kept = join(scratch('result'), resultFile(name, def.commit));
    writeFileSync(kept, resultText(result));
    throw new Error(`${error.message}; the run's result is in ${kept}, outside the repository`);
  }
  console.log(`wrote ${path}; run \`pnpm facilitators:table\` to update docs/facilitators.md`);
}

await main();
