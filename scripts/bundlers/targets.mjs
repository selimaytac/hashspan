// One entry per bundler, with the docker run arguments of the three containers of a run. `e16-anvil` owns the network
// namespace: it is on the `e16-net` network, resolves names through 127.0.0.1 only (so no public name resolves inside
// the namespace) and publishes Anvil's port and the bundler's port on 127.0.0.1. The faults proxy and the bundler join
// it with `--network container:e16-anvil`, so all three talk over 127.0.0.1 and the proxy keeps refusing remote
// upstreams. Each container is `--rm`, limited to 2 GiB and mounts nothing of the host.
//
// Inside the namespace every bundler listens on 0.0.0.0: Docker forwards a published port to the namespace's
// interface address, so a server bound to its loopback would not be reachable. Only the 127.0.0.1 publish reaches the
// host. That is why no bundler of the matrix ever runs on the host: Alto's host is fixed to 0.0.0.0 (alto#767) and
// Rundler's RPC and metrics listen on 0.0.0.0 by default, which on a host is every network interface.
//
// v1 runs every bundler in its unsafe (no-tracer) mode: full ERC-7562 validation needs debug_traceCall with a
// JavaScript or custom tracer, which Anvil does not offer. The facts of each wave-1 target were read from its source at
// the pinned tag; `start.verified: false` until a lab run starts it.
import { ACCOUNTS, CHAIN_ID, ENTRY_POINTS } from './corpus.mjs';
import { RUNDLER_RELEASE } from './rundler.mjs';

/** Prefix of every container, image and network the harness creates (experiment e16). */
export const PREFIX = 'e16-';
/** Memory limit of every container. */
export const MEMORY = '2g';
/** The user-defined network `e16-anvil` is on; a plain bridge, which publishing ports needs. */
export const DOCKER_NETWORK = `${PREFIX}net`;

/**
 * Anvil, from the Foundry release `scripts/install-anvil.sh` pins; the digest is recorded by the run. Its code size
 * limit is raised as in Alto's own e2e setup (test/e2e/docker-compose.yml:5 at v1.2.8), for Alto's simulation
 * contracts.
 */
export const ANVIL = {
  image: 'ghcr.io/foundry-rs/foundry:v1.8.4',
  digest: null,
  port: 8545,
  hostPort: 18565,
  codeSizeLimit: 100_000_000,
};
/** The bundler's JSON-RPC port inside the namespace, and where `e16-anvil` publishes it. */
export const BUNDLER_PORT = { container: 4337, host: 14337 };
/** Where every bundler listens inside the namespace. */
export const LISTEN_HOST = '0.0.0.0';

/** What the harness waits beyond a target's bundle interval before it takes an operation as not included. */
export const RECEIPT_MARGIN_MS = 30_000;

/** @type {Record<string, any>} */
export const targets = {
  rundler: {
    title: 'Rundler',
    wave: 1,
    repo: RUNDLER_RELEASE.repo,
    version: RUNDLER_RELEASE.tag,
    commit: RUNDLER_RELEASE.commit,
    language: 'Rust',
    licence: 'LGPL-3.0-only (library), GPL-3.0 (bin)',
    build: 'release-binary',
    dockerfile: 'rundler.Dockerfile',
    rpcPath: '/',
    // bin/rundler/src/cli/rpc.rs:42-45 (`--rpc.host`, default 0.0.0.0), passed explicitly.
    listen: { how: 'flag --rpc.host', source: 'bin/rundler/src/cli/rpc.rs:42-45' },
    // bin/rundler/src/cli/mod.rs:238 (`--unsafe`); docs/cli.md:80: skips the simulation rules and any debug_traceCall.
    unsafe: { flag: '--unsafe', source: 'bin/rundler/src/cli/mod.rs:238, docs/cli.md:80' },
    keys: { SIGNER_PRIVATE_KEYS: 'executor' },
    keysSource: 'bin/rundler/src/cli/signer.rs:27-29 (env SIGNER_PRIVATE_KEYS)',
    // bin/rundler/chain_specs/dev.toml:6 (bundle_max_send_interval_millis = 250).
    bundleInterval: { ms: 250, source: 'bin/rundler/chain_specs/dev.toml:6' },
    // The dev spec inherits ethereum.toml, which names the Flashbots relay; the default sender is `raw`
    // (bin/rundler/src/cli/builder.rs:88-92), and no public name resolves in the namespace anyway.
    command: (rpcUrl) => [
      'node',
      '--network',
      'dev',
      '--node_http',
      rpcUrl,
      '--unsafe',
      '--rpc.host',
      LISTEN_HOST,
      '--rpc.port',
      String(BUNDLER_PORT.container),
      '--rpc.api',
      'eth,rundler,debug',
      '--metrics.host',
      '127.0.0.1',
      '--enabled_entry_points',
      'v0.7',
    ],
    start: { command: 'rundler node --network dev --unsafe', verified: false },
    known: ['rundler#1354'],
  },
  alto: {
    title: 'Alto',
    wave: 1,
    repo: 'https://github.com/pimlicolabs/alto',
    version: 'v1.2.8',
    commit: '37cade5d2804a60ab30362ea27054514e1d7a7c8',
    language: 'TypeScript',
    licence: 'GPL-3.0-or-later',
    build: 'git-archive',
    dockerfile: 'alto.Dockerfile',
    // Only Alto's own package (src/), with the workspace manifests pnpm's frozen lockfile needs and the contracts
    // the build compiles; not the e2e tests or the local deployer.
    archive: [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'src',
      'contracts',
      'test/e2e/package.json',
      'scripts/localDeployer/package.json',
    ],
    // contracts/lib/* are git submodules, empty in an archive: images.mjs fetches each at the commit the tag records.
    // test/spec-tests/bundler-spec-tests is not fetched (no licence file; cited only).
    submodules: 'contracts/lib',
    rpcPath: '/',
    // src/rpc/server.ts:165 listens on host "0.0.0.0", fixed (alto#767); contained by the 127.0.0.1 publish.
    listen: { how: 'fixed in the source (alto#767)', source: 'src/rpc/server.ts:165' },
    unsafe: { flag: '--safe-mode false', source: 'src/cli/config/options.ts:45-49' },
    // yargs reads options from ALTO_* env variables (src/cli/alto.ts:76).
    keys: { ALTO_EXECUTOR_PRIVATE_KEYS: 'executor', ALTO_UTILITY_PRIVATE_KEY: 'utility' },
    keysSource: 'src/cli/alto.ts:76 (.env("ALTO")), src/cli/config/options.ts:477, 539',
    // src/cli/config/options.ts:853-858 (max-bundle-interval, default 1000 ms).
    bundleInterval: { ms: 1000, source: 'src/cli/config/options.ts:853-858' },
    command: (rpcUrl) => [
      'run',
      '--rpc-url',
      rpcUrl,
      '--entrypoints',
      ENTRY_POINTS['0.7'],
      '--port',
      String(BUNDLER_PORT.container),
      '--safe-mode',
      'false',
      '--deploy-simulations-contract',
      'true',
      '--enable-debug-endpoints',
      'true',
      '--network-name',
      'local',
    ],
    start: { command: 'node src/esm/cli/alto.js run --safe-mode false', verified: false },
    known: [],
  },
  voltaire: {
    title: 'Voltaire',
    wave: 1,
    repo: 'https://github.com/candidelabs/voltaire',
    version: 'v1.0.5',
    commit: 'e5235403828889fc4cd3e632a344816ba24af3aa',
    language: 'Python',
    licence: 'LGPL-3.0',
    build: 'git-archive',
    dockerfile: 'voltaire.Dockerfile',
    // The committed voltaire-p2p binary (x86-64) is left out: p2p is off by default (cli_manager.py:563-570).
    archive: ['pyproject.toml', 'poetry.lock', 'requirements.txt', 'README.md', 'voltaire_bundler'],
    rpcPath: '/rpc',
    // voltaire_bundler/cli_manager.py:238-245 (`--rpc_url`, the listen host, default 127.0.0.1); rpc_path default
    // /rpc (cli_manager.py:256-263).
    listen: { how: 'flag --rpc_url', source: 'voltaire_bundler/cli_manager.py:238-245' },
    unsafe: { flag: '--unsafe', source: 'voltaire_bundler/cli_manager.py:332-343' },
    keys: { VOLTAIRE_BUNDLER_SECRET: 'executor' },
    keysSource: 'voltaire_bundler/cli_manager.py:205-216 (env VOLTAIRE_BUNDLER_SECRET)',
    // voltaire_bundler/cli_manager.py:383-399 (bundle_interval, default 2 s).
    bundleInterval: { ms: 2000, source: 'voltaire_bundler/cli_manager.py:383-399' },
    // Not --debug: it would expose the debug namespace but also stop the automatic bundling (cli_manager.py:310-317,
    // 383-399). It checks at start that EntryPoints v0.7, v0.8 and v0.9 (and v0.6 unless disabled) have code
    // (cli_manager.py:1004-1021, 1108-1110); the chain has v0.7 only, so the check is off and v0.6 is disabled.
    command: (rpcUrl) => [
      '--ethereum_node_url',
      rpcUrl,
      '--chain_id',
      String(CHAIN_ID),
      '--rpc_url',
      LISTEN_HOST,
      '--rpc_port',
      String(BUNDLER_PORT.container),
      '--unsafe',
      '--disable_p2p',
      '--disable_v6',
      '--disable_entrypoints_code_check',
    ],
    start: { command: 'python -m voltaire_bundler --unsafe', verified: false },
    known: [],
  },
  skandha: {
    title: 'Skandha',
    wave: 2,
    notYetRun: true,
    repo: 'https://github.com/etherspot/skandha',
    version: 'v2-2.4.6',
    commit: '0f7126920827b57d5f1515b15d9d6d17a4d78250',
    language: 'TypeScript',
    licence: 'MIT',
    note: 'after wave 1 agrees on the valid cases: a bun build from source, config.json, --unsafeMode; listens on 0.0.0.0:14337 by default',
    known: [],
  },
  'eth-infinitism': {
    title: 'eth-infinitism bundler (reference)',
    wave: 'reference',
    notYetRun: true,
    repo: 'https://github.com/eth-infinitism/bundler',
    language: 'TypeScript',
    licence: 'MIT',
    note: "the spec authors' answer, a reference column, not a gating target; bundler-spec-tests are cited, not vendored",
    known: [],
  },
  silius: {
    title: 'Silius',
    wave: 'out',
    notYetRun: true,
    repo: 'https://github.com/silius-rs/silius',
    language: 'Rust',
    licence: 'Apache-2.0',
    note: 'out: no release since v0.5.0-alpha (2024-05-10), no commit since 2025-03-24, EntryPoint v0.6 only',
    known: [],
  },
};

/** The targets of one wave, as `[name, definition]` pairs. */
export const wave = (n) => Object.entries(targets).filter(([, def]) => def.wave === n);

/** How long the harness waits for an operation's receipt: the target's bundle interval plus the margin. */
export const receiptTimeoutOf = (def) => def.bundleInterval.ms + RECEIPT_MARGIN_MS;

/** Container name of a target or helper. */
export const containerOf = (name) => `${PREFIX}${name}`;
/** Image tag of a target or helper: the name and the commit it is built from. */
export const imageOf = (name, commit) => `${PREFIX}${name}:${String(commit).slice(0, 12)}`;

const ANVIL_CONTAINER = containerOf('anvil');
const JOIN = `container:${ANVIL_CONTAINER}`;

/** The bundler's URL inside the namespace's publish, on the host. */
export const bundlerUrl = (def) =>
  `http://127.0.0.1:${BUNDLER_PORT.host}${def.rpcPath === '/' ? '' : def.rpcPath}`;

/** Secret values passed to the bundler through the docker process's environment, by name only. */
export const secretEnv = (def) =>
  Object.fromEntries(Object.entries(def.keys).map(([name, role]) => [name, ACCOUNTS[role]]));

/** `docker run` arguments of Anvil, which owns the namespace. */
export function anvilArgs(image = ANVIL.digest ? `${ANVIL.image}@${ANVIL.digest}` : ANVIL.image) {
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    ANVIL_CONTAINER,
    '--network',
    DOCKER_NETWORK,
    '--dns',
    '127.0.0.1',
    `--memory=${MEMORY}`,
    '--publish',
    `127.0.0.1:${ANVIL.hostPort}:${ANVIL.port}`,
    '--publish',
    `127.0.0.1:${BUNDLER_PORT.host}:${BUNDLER_PORT.container}`,
    '--entrypoint',
    'anvil',
    image,
    '--host',
    LISTEN_HOST,
    '--port',
    String(ANVIL.port),
    '--chain-id',
    String(CHAIN_ID),
    '--code-size-limit',
    String(ANVIL.codeSizeLimit),
  ];
}

/** `docker run` arguments of the faults proxy, with its scenario (rules by method), armed later by a signal. */
export function proxyArgs(scenario, image) {
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerOf('faults'),
    '--network',
    JOIN,
    `--memory=${MEMORY}`,
    '--env',
    `FAULT_SCENARIO=${JSON.stringify(scenario)}`,
    '--env',
    `FAULT_UPSTREAM=http://127.0.0.1:${ANVIL.port}`,
    image,
  ];
}

/**
 * `docker run` arguments of a bundler, whose node is the proxy's URL inside the namespace. Its keys are passed by
 * name, so the values come from the docker process's environment (`secretEnv()`) and never appear in the arguments.
 */
export function bundlerArgs(name, def, rpcUrl, image = imageOf(name, def.commit ?? '')) {
  if (def.notYetRun) throw new Error(`${name} is not run by the matrix: ${def.note}`);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) {
    throw new Error('the bundler node is the proxy on 127.0.0.1 inside the namespace');
  }
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerOf(name),
    '--network',
    JOIN,
    `--memory=${MEMORY}`,
    ...Object.keys(def.keys).flatMap((k) => ['--env', k]),
    image,
    ...def.command(rpcUrl),
  ];
}

/** The listen host a bundler's command sets, or the fixed one its entry names (Alto). */
export function listenHostOf(def) {
  const args = def.command('http://127.0.0.1:1');
  for (const flag of ['--rpc.host', '--rpc_url']) {
    const i = args.indexOf(flag);
    if (i !== -1) return args[i + 1];
  }
  return def.listen.how.startsWith('fixed') ? LISTEN_HOST : undefined;
}
