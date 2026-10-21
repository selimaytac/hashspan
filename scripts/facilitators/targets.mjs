// One entry per facilitator, with the docker run arguments of the three containers of a run. Anvil runs on the host
// clock, as the facilitators judge validity windows by theirs, so the chain and the targets agree on the time; only
// the committed corpus and its Anvil test use the fixed past time. `e14-anvil` owns the
// network namespace: it is on the `e14-net` network, resolves names through 127.0.0.1 only (so a public RPC name does
// not resolve inside the namespace) and publishes Anvil's port and the facilitator's port on 127.0.0.1. The faults
// proxy and the facilitator join it with `--network container:e14-anvil`, so all three talk over 127.0.0.1 and the
// proxy keeps refusing remote upstreams. Each container is `--rm`, limited to 2 GiB and mounts nothing of the host.
//
// The facts of each target were read from its source at the pinned commit; `start.verified: false` until a lab run
// starts it.
import { randomBytes } from 'node:crypto';
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
/** x402-rs at tag v2.0.2, read on 2026-10-21. */
export const X402_RS_COMMIT = '0b14f39afb604a7df25b3496ba34122bdca45a7f';
/** qntx/facilitator at tag v0.7.1, read on 2026-10-21. */
export const QNTX_COMMIT = 'de13a74d5cd26d4fdd716af3df91b5436cc2c7e3';

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
    // How long the facilitator waits for a settle receipt; the harness waits that long plus SETTLE_MARGIN_MS.
    receiptWait: {
      ms: 180_000,
      source:
        'e2e/facilitators/typescript/index.ts:492-493 (viem waitForTransactionReceipt with no timeout: its default 180_000)',
    },
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
    receiptWait: {
      ms: 30_000,
      source:
        'e2e/facilitators/go/main.go:369-383 (30 polls of TransactionReceipt, one second apart; no timeout per poll)',
    },
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
    receiptWait: {
      ms: 120_000,
      source:
        'python/x402/mechanisms/evm/signers.py:38 (_DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 120; e2e/facilitators/python/main.py:124 keeps it)',
    },
    known: [],
  },
  // Wave 2: the two Rust facilitators, each at the commit of its latest release tag, read on 2026-10-21. Each reads a
  // config file the harness generates (configOf()), copied into the image at build time. The file names the RPC URL
  // and the key by environment variable only, so one image serves every fault case of a run, whose proxy port changes.
  'x402-rs': {
    title: 'x402-rs x402-facilitator',
    wave: 2,
    repo: 'https://github.com/x402-rs/x402-rs',
    commit: X402_RS_COMMIT,
    // The newest tag. GitHub's Releases page still marks v1.3.0 (2026-02-15) as the latest release. v2.0.2 to main
    // (e75adda8, the base of PRs #138 and #140) differs in crates/chains/x402-chain-tron only.
    release: { tag: 'v2.0.2', date: '2026-07-12' },
    path: 'facilitator',
    language: 'Rust',
    dockerfile: 'x402-rs.Dockerfile',
    // Cargo loads every workspace member (examples/ too) and the aptos patch path (patches/) before it builds one.
    archive: ['Cargo.toml', 'Cargo.lock', 'crates', 'facilitator', 'examples', 'patches'],
    config: {
      file: 'hashspan-facilitator.json',
      image: '/etc/x402-rs/config.json',
      source:
        'crates/x402-types/src/config.rs:203-207, 214-224; facilitator/src/config.rs:141-230 (chains by CAIP-2 key)',
    },
    rpc: {
      env: 'EVM_RPC_URL',
      key: 'chains."eip155:84532".rpc[].http, as "$EVM_RPC_URL"',
      fallback:
        'none: rpc is a required field and the transport is built from the configured list only; an unset variable stops the start',
      source:
        'crates/chains/x402-chain-eip155/src/chain/config.rs:82, crates/x402-types/src/config.rs:150-157, crates/chains/x402-chain-eip155/src/chain/provider.rs:91-118',
      checkedAt: X402_RS_COMMIT,
    },
    chainId: {
      from: 'the CAIP-2 key of the config (any eip155:<u64>); the signer takes it, and the payload network must equal it',
      source:
        'crates/chains/x402-chain-eip155/src/chain/types.rs:132-146, crates/chains/x402-chain-eip155/src/chain/provider.rs:154, crates/chains/x402-chain-eip155/src/v2_eip155_exact/facilitator/eip3009.rs:80-84',
      // Research open question 1, from source: the asset is the requirement's, and the EIP-712 domain is its extra
      // name and version with the configured chain id. No token table is read (the USDC table is in doc comments only).
      customAsset:
        'yes: the asset of the requirement and its extra name and version, no token table (read for EIP-3009; Permit2 and upto by grep)',
      customAssetSource:
        'crates/chains/x402-chain-eip155/src/v2_eip155_exact/facilitator/eip3009.rs:92-102, crates/chains/x402-chain-eip155/src/v1_eip155_exact/facilitator.rs:357-402',
    },
    // The start checks that these addresses hold code. The validator is called for EIP-6492 signatures only, which the
    // corpus has none of, so chain.mjs installs a stub there.
    requiredContracts: {
      addresses: [
        '0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B',
        '0x000000000022D473030F116dDEE9F6B43aC78BA3',
        '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
      ],
      source: 'crates/chains/x402-chain-eip155/src/chain/provider.rs:38-44, 199, 446-459',
    },
    listen: {
      address: '0.0.0.0',
      source: 'crates/x402-types/src/config.rs:214-224, facilitator/src/run.rs:123-127',
    },
    supported: {
      schemes: ['exact', 'upto'],
      source:
        'facilitator/src/run.rs:86-91, crates/chains/x402-chain-eip155/src/v2_eip155_exact/facilitator/mod.rs:236-241, crates/chains/x402-chain-eip155/src/v2_eip155_upto/facilitator/mod.rs:184-189',
    },
    // Built with the default features, as the justfile's `cargo build` (upstream's Dockerfile adds aptos).
    start: { command: 'x402-facilitator --config <file>', verified: false },
    receiptWait: {
      ms: 30_000,
      source:
        'crates/chains/x402-chain-eip155/src/chain/config.rs:84-85, 95-97 (receipt_timeout_secs, default 30), crates/chains/x402-chain-eip155/src/chain/provider.rs:311-322',
    },
    known: ['x402-rs#136'],
  },
  qntx: {
    title: 'qntx/facilitator',
    wave: 2,
    repo: 'https://github.com/qntx/facilitator',
    commit: QNTX_COMMIT,
    // MIT OR Apache-2.0 since 2026-08-09 (FSL-1.1-ALv2 before); the pinned tag is after the change.
    release: { tag: 'v0.7.1', date: '2026-09-05' },
    path: 'crates/facilitator',
    language: 'Rust',
    dockerfile: 'qntx.Dockerfile',
    // Not rust-toolchain.toml: its `channel = "stable"` would make rustup fetch another toolchain (upstream's
    // .dockerignore leaves it out too). The verify and settle logic is in the r402 crates of the lockfile.
    archive: ['Cargo.toml', 'Cargo.lock', 'crates'],
    crates: {
      'r402-evm': {
        version: '0.20.0',
        sha256: 'ef9be187aaf1525bd4e487293805ef4170390cde97ec93c015919f89e923f274',
      },
      'r402-facilitator': {
        version: '0.20.0',
        sha256: '1b15e800c9982cea76c9db113372b8111a40eca64857a6f1cdda208f4e7b8ef2',
      },
    },
    config: {
      file: 'hashspan-facilitator.toml',
      image: '/etc/facilitator/config.toml',
      source: 'crates/facilitator/src/cli.rs:26-33, crates/facilitator/src/config/mod.rs:115-150',
    },
    rpc: {
      env: 'EVM_RPC_URL',
      key: 'network."eip155:84532".rpc_env = "EVM_RPC_URL"',
      fallback:
        'none: an EVM network needs exactly one of rpc or rpc_env, and an unset rpc_env variable stops the start',
      source: 'crates/facilitator/src/config/network.rs:463, 1237-1250, 1446-1462',
      checkedAt: QNTX_COMMIT,
    },
    chainId: {
      from: 'the CAIP-2 key of the config (any eip155:<u64>); the payload network must equal it',
      source:
        'crates/facilitator/src/config/network.rs:1320-1327, r402-evm 0.20.0 src/exact/facilitator/verify.rs:52-56',
      // Research open question 2, from source: any EIP-155 reference is accepted. The asset is the requirement's and
      // must hold code; the domain is its extra name and version (or the token's) with the configured chain id.
      customAsset:
        'yes: the asset of the requirement (it must hold code) and its extra name and version, no token table (read for EIP-3009; upto by grep)',
      customAssetSource: 'r402-evm 0.20.0 src/exact/facilitator/verify.rs:63-76, 154-190',
    },
    requiredContracts: {
      addresses: [],
      source: 'r402-evm 0.20.0 src/chain/provider.rs:108-152 (no code check at the start)',
    },
    listen: {
      address: '0.0.0.0',
      // A listen address other than loopback needs [http.auth]; /verify, /settle and /supported then need the bearer.
      source:
        'crates/facilitator/src/config/http.rs:14, crates/facilitator/src/config/mod.rs:300-307, crates/facilitator/src/http/mod.rs:168-187',
    },
    auth: {
      env: 'FACILITATOR_API_TOKEN',
      source:
        'crates/facilitator/src/config/http.rs:47-70, crates/facilitator/src/http/auth.rs:13-29',
    },
    // auth-capture is left out: the corpus has no case of it, and its facilitator is built at the start (try_new).
    supported: {
      schemes: ['batch-settlement', 'exact', 'upto'],
      source: 'crates/facilitator/src/compose/evm.rs:78-86 (the schemes of the config)',
    },
    start: { command: 'facilitator serve -c <file>', verified: false },
    // The HTTP layer ends a settle at settle_timeout (default 30 s, with a 504), which must be at least the receipt
    // timeout plus 2 s; the harness waits the receipt timeout plus its margin, beyond both.
    receiptWait: {
      ms: 20_000,
      source:
        'crates/facilitator/src/config/network.rs:15, 820-822 (receipt_timeout_secs, default 20), r402-evm 0.20.0 src/chain/provider.rs:455-462; settle_timeout: crates/facilitator/src/config/mod.rs:352-366',
    },
    known: ['qntx#73'],
  },
};

/** What the harness waits beyond a target's own receipt wait before it counts a settle as timed out. */
export const SETTLE_MARGIN_MS = 30_000;

/** How long the harness waits for a target's settle answer: its receipt wait plus the margin. */
export const settleTimeoutOf = (def) => def.receiptWait.ms + SETTLE_MARGIN_MS;

/** The targets of one wave, as `[name, definition]` pairs. */
export const wave = (n) => Object.entries(targets).filter(([, def]) => def.wave === n);

/** Container name of a target or helper. */
export const containerOf = (name) => `${PREFIX}${name}`;
/** Image tag of a target or helper: the name and the commit it is built from. */
export const imageOf = (name, commit) => `${PREFIX}${name}:${String(commit).slice(0, 12)}`;

const ANVIL_CONTAINER = containerOf('anvil');
const JOIN = `container:${ANVIL_CONTAINER}`;

/** The environment variable that carries the facilitator's key, in every target and in every generated config. */
export const KEY_ENV = 'FACILITATOR_EVM_PRIVATE_KEY';

/** A bearer token for one run: random, held in memory, passed by environment name and never written. */
export const newRunToken = () => randomBytes(32).toString('hex');

/** Names of the secret environment variables a target gets: the key, and its bearer token if it has one. */
export const secretNames = (def) => [KEY_ENV, ...(def?.auth ? [def.auth.env] : [])];

/**
 * Secret values passed to the facilitator through the docker process's environment, by name only: the key, and the
 * run's bearer token for a target that has one.
 */
export function secretEnv(def, token) {
  const env = { [KEY_ENV]: ACCOUNTS.facilitator };
  if (def?.auth) {
    if (!token) throw new Error(`${def.title} needs the run's bearer token`);
    env[def.auth.env] = token;
  }
  return env;
}

/** Headers the harness sends with every call to a target: the bearer token for a target that has one. */
export const authHeaders = (def, token) => (def?.auth ? { authorization: `Bearer ${token}` } : {});

/**
 * The config file a target reads, generated for chain id 84532: listening on 0.0.0.0 inside the namespace (Anvil
 * publishes the port on 127.0.0.1), the RPC URL and the key named by environment variable, and the schemes the target
 * is run with. Undefined for a target without one.
 */
export function configOf(name) {
  if (name === 'x402-rs') {
    const config = {
      port: FACILITATOR_PORT.container,
      host: '0.0.0.0',
      chains: {
        [NETWORK]: {
          eip1559: true,
          flashblocks: false,
          signers: [`$${KEY_ENV}`],
          rpc: [{ http: `$${targets['x402-rs'].rpc.env}` }],
        },
      },
      schemes: [
        { id: 'v2-eip155-exact', chains: NETWORK },
        { id: 'v2-eip155-upto', chains: NETWORK },
      ],
    };
    return { file: targets['x402-rs'].config.file, text: `${JSON.stringify(config, null, 2)}\n` };
  }
  if (name === 'qntx') {
    const def = targets.qntx;
    const list = (items) => `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
    const text = [
      '[http]',
      `listen = "0.0.0.0:${FACILITATOR_PORT.container}"`,
      '',
      '[http.auth]',
      `bearer_env = "${def.auth.env}"`,
      '',
      '[log]',
      'level = "info"',
      'format = "compact"',
      '',
      '[signer.evm_hot]',
      'source = "env"',
      `env = "${KEY_ENV}"`,
      '',
      `[network."${NETWORK}"]`,
      `rpc_env = "${def.rpc.env}"`,
      'signers = ["evm_hot"]',
      `schemes = ${list(def.supported.schemes)}`,
      'eip1559 = true',
      'flashblocks = false',
      '',
    ].join('\n');
    return { file: def.config.file, text };
  }
  return undefined;
}

/** A git ref `--ref` accepts: letters, digits and `._/-`, no leading `-`, no `..`. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** Checks a git ref given with `--ref`; returns it with its pull request number, if it is a `pull/<n>/head`. */
export function parseRef(ref) {
  if (typeof ref !== 'string' || !REF.test(ref)) {
    throw new Error('--ref takes a git ref such as pull/138/head (letters, digits, ._/-)');
  }
  const pr = /^pull\/(\d+)\/head$/.exec(ref);
  return { ref, pr: pr ? Number(pr[1]) : null };
}

/**
 * A target at another git ref of its repository (a pull request head): the commit the ref resolved to, with the ref,
 * its pull request number and the pinned commit it is compared with. Its image and result file are named after that
 * commit, so they sit next to the pinned commit's.
 */
export function refTarget(def, ref, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('a ref resolves to a full commit hash');
  const { pr } = parseRef(ref);
  return { ...def, commit, ref, pr, baseCommit: def.commit };
}

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
 * `docker run` arguments of a facilitator, whose RPC is the proxy's URL inside the namespace. Its secrets are passed
 * by name, so the values come from the docker process's environment (`secretEnv()`) and never appear in the
 * arguments. A target with a config file reads its port and network from the file, which its image holds.
 */
export function facilitatorArgs(name, def, rpcUrl, image = imageOf(name, def.commit ?? '')) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) {
    throw new Error('the facilitator RPC is the proxy on 127.0.0.1 inside the namespace');
  }
  const env = def.config
    ? { [def.rpc.env]: rpcUrl }
    : { PORT: String(FACILITATOR_PORT.container), EVM_NETWORK: NETWORK, [def.rpc.env]: rpcUrl };
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
    ...secretNames(def).flatMap((k) => ['--env', k]),
    image,
  ];
}
