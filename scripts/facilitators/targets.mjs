// One entry per facilitator, with the docker run arguments of the three containers of a run. Anvil runs on the host
// clock, as the facilitators judge validity windows by theirs, so the chain and the targets agree on the time; only
// the committed corpus and its Anvil test use the fixed past time. `e14-anvil` owns the
// network namespace: it is on the `e14-net` network, resolves names through 127.0.0.1 only (so a public RPC name does
// not resolve inside the namespace) and publishes Anvil's port and the facilitator's port on 127.0.0.1. The faults
// proxy and the facilitator join it with `--network container:e14-anvil`, so all three talk over 127.0.0.1 and the
// proxy keeps refusing remote upstreams. Each container is `--rm`, limited to 2 GiB and mounts nothing of the host.
//
// The facts of each wave-1 target were read from its source at the pinned commit; `start.verified: false` until a
// lab run starts it. Wave-2 entries are not run yet.
import { ACCOUNTS, CHAIN_ID, NETWORK } from './corpus.mjs';

/** Prefix of every container, image and network the harness creates (experiment e14). */
export const PREFIX = 'e14-';
/** Memory limit of every container. */
export const MEMORY = '2g';
/** The user-defined network `e14-anvil` is on; a plain bridge, which publishing ports needs. */
export const DOCKER_NETWORK = `${PREFIX}net`;

/** The x402 commit wave 1 runs, read on 2026-10-21. */
export const X402_COMMIT = 'faa1c694c66a3732aaabbce93bdae140e521a67d';
const X402_REPO = 'https://github.com/x402-foundation/x402';

/** Anvil, from the Foundry release `scripts/install-anvil.sh` pins; the digest is recorded by the run. */
export const ANVIL = {
  image: 'ghcr.io/foundry-rs/foundry:v1.8.4',
  digest: null,
  port: 8545,
  hostPort: 18545,
};
/** The facilitator's HTTP port inside the namespace, and where `e14-anvil` publishes it. */
export const FACILITATOR_PORT = { container: 4022, host: 14022 };

/** @type {Record<string, any>} */
export const targets = {
  typescript: {
    title: 'x402 e2e facilitator (TypeScript)',
    wave: 1,
    repo: X402_REPO,
    commit: X402_COMMIT,
    path: 'e2e/facilitators/typescript',
    language: 'TypeScript',
    dockerfile: 'typescript.Dockerfile',
    // The archive the image is built from; e2e/config holds the network catalog every target reads.
    archive: ['typescript', 'e2e'],
    rpc: {
      env: 'EVM_RPC_URL',
      fallback:
        'viem http() with no URL: the default RPC of viem baseSepolia (public Base Sepolia) when EVM_RPC_URL is unset',
      source: 'e2e/facilitators/typescript/index.ts:151, 447-453',
      checkedAt: X402_COMMIT,
    },
    chainId: {
      from: 'viem baseSepolia (84532) for every network but eip155:8453; Anvil runs with --chain-id 84532',
      source: 'e2e/facilitators/typescript/index.ts:163-171',
    },
    // From e2e/facilitators/typescript/package.json (`start`) and the e2e CI job (.github/workflows/e2e_tests.yml):
    // pnpm install and build in typescript/, pnpm install in e2e/, Node.js 22.
    start: { command: 'tsx index.ts', verified: false },
    known: [],
  },
  go: {
    title: 'x402 e2e facilitator (Go)',
    wave: 1,
    repo: X402_REPO,
    commit: X402_COMMIT,
    path: 'e2e/facilitators/go',
    language: 'Go',
    dockerfile: 'go.Dockerfile',
    archive: ['go', 'e2e'],
    rpc: {
      env: 'EVM_RPC_URL',
      fallback: 'https://sepolia.base.org (public Base Sepolia) when EVM_RPC_URL is unset',
      source: 'e2e/facilitators/go/main.go:909-922',
      checkedAt: X402_COMMIT,
    },
    chainId: { from: 'eth_chainId over the RPC', source: 'e2e/facilitators/go/main.go:99' },
    // e2e/setup.sh builds a Go component with `go mod tidy` and `go build`; Go 1.24 as in the e2e CI job.
    start: { command: 'go build, then the binary', verified: false },
    known: [],
  },
  python: {
    title: 'x402 e2e facilitator (Python)',
    wave: 1,
    repo: X402_REPO,
    commit: X402_COMMIT,
    path: 'e2e/facilitators/python',
    language: 'Python',
    dockerfile: 'python.Dockerfile',
    archive: ['python', 'e2e'],
    rpc: {
      env: 'EVM_RPC_URL',
      fallback: 'https://sepolia.base.org (public Base Sepolia) when EVM_RPC_URL is unset',
      source: 'e2e/facilitators/python/main.py:122-123',
      checkedAt: X402_COMMIT,
    },
    chainId: {
      from: 'the RPC, through FacilitatorWeb3Signer of python/x402 (that file not read yet)',
      source: 'e2e/facilitators/python/main.py:122-127',
    },
    // e2e/setup.sh runs `uv sync` for a Python component; main.py starts uvicorn on 0.0.0.0:$PORT; Python 3.10 as in
    // the e2e CI job.
    start: { command: 'uv run python main.py', verified: false },
    known: [],
  },
  'x402-rs': {
    title: 'x402-rs x402-facilitator',
    wave: 2,
    notYetRun: true,
    repo: 'https://github.com/x402-rs/x402-rs',
    commit: null,
    language: 'Rust',
    note: 'JSON config per CAIP-2 network with an rpc URL and a signer env var; after the wave-1 gate',
    known: ['x402-rs#136'],
  },
  qntx: {
    title: 'qntx/facilitator',
    wave: 2,
    notYetRun: true,
    repo: 'https://github.com/qntx/facilitator',
    commit: null,
    language: 'Rust',
    note: 'TOML config with an rpc list per network; a non-loopback listen needs a bearer token; after the wave-1 gate',
    known: ['qntx#73'],
  },
};

/** The targets of one wave, as `[name, definition]` pairs. */
export const wave = (n) => Object.entries(targets).filter(([, def]) => def.wave === n);

/** Container name of a target or helper. */
export const containerOf = (name) => `${PREFIX}${name}`;
/** Image tag of a target or helper: the name and the commit it is built from. */
export const imageOf = (name, commit) => `${PREFIX}${name}:${String(commit).slice(0, 12)}`;

const ANVIL_CONTAINER = containerOf('anvil');
const JOIN = `container:${ANVIL_CONTAINER}`;

/** Secret values passed to the facilitator through the docker process's environment, by name only. */
export const secretEnv = () => ({ FACILITATOR_EVM_PRIVATE_KEY: ACCOUNTS.facilitator });

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
    `127.0.0.1:${FACILITATOR_PORT.host}:${FACILITATOR_PORT.container}`,
    '--entrypoint',
    'anvil',
    image,
    '--host',
    '0.0.0.0',
    '--port',
    String(ANVIL.port),
    '--chain-id',
    String(CHAIN_ID),
  ];
}

/** `docker run` arguments of the faults proxy, with its scenario (rules by method) in an env variable. */
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
 * `docker run` arguments of a facilitator, whose RPC is the proxy's URL inside the namespace. Its key is passed by
 * name, so the value comes from the docker process's environment (`secretEnv()`) and never appears in the arguments.
 */
export function facilitatorArgs(name, def, rpcUrl, image = imageOf(name, def.commit ?? '')) {
  if (def.notYetRun)
    throw new Error(`${name} is a wave-${def.wave} target, not yet run: ${def.note}`);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) {
    throw new Error('the facilitator RPC is the proxy on 127.0.0.1 inside the namespace');
  }
  const env = {
    PORT: String(FACILITATOR_PORT.container),
    EVM_NETWORK: NETWORK,
    [def.rpc.env]: rpcUrl,
  };
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerOf(name),
    '--network',
    JOIN,
    `--memory=${MEMORY}`,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...Object.keys(secretEnv()).flatMap((k) => ['--env', k]),
    image,
  ];
}
