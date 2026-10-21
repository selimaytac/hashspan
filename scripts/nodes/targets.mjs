// One entry per dev node of the matrix. Anvil and Hardhat run as local processes on 127.0.0.1; Reth and Geth run in
// Docker, one container at a time, named `e15-<node>`, removed after the run (`--rm`), limited to 2 GiB, with only the
// HTTP JSON-RPC port published and only on 127.0.0.1 (no p2p, auth or metrics port), no path of the host mounted
// (Reth's datadir is a named `e15-` volume, Geth keeps its chain in memory), and each image pinned by its digest.
//
// Facts marked `verified` were read on 2026-10-21 from the source at the pinned tag (flags), from the registry (image
// digests and entrypoints) or from the release (archive checksums); `start.verified` stays false until a lab run
// starts the node.

/** Prefix of every container and volume the harness creates (experiment e15). */
export const PREFIX = 'e15-';
/** Memory limit of every container. */
export const MEMORY = '2g';
/** The HTTP JSON-RPC port every node listens on (inside its container for Reth and Geth). */
export const RPC_PORT = 8545;
/** Where the node answers on the host: 127.0.0.1 only. */
export const HOST_PORT = 18555;
export const RPC_URL = `http://127.0.0.1:${HOST_PORT}`;

/** Anvil's pinned release, and the SHA-256 of each release archive as the release lists them (2026-10-21). */
export const ANVIL_RELEASE = {
  tag: 'v1.8.5',
  version: '1.8.5',
  commit: '51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f',
  sha256: {
    darwin_arm64: '56049728e25e44a61c7f2e49438023b0890cb45850ffcb7c882f90cd998baf83',
    darwin_amd64: 'b919f69bb4231ad68beaaba9dc8f7d36d9d552cef1a76a8bf69c2bdfd974339a',
    linux_amd64: '6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226',
    linux_arm64: '5bdce3dade8b6f0a65d4fccf6908426aee4905a988b08dce79d0a72fe7498310',
  },
};

/** Hardhat and the EDR version it must run on: 3.20.0 depends on EDR 0.23.0 exactly, so an override sets 0.24.0. */
export const HARDHAT = { version: '3.20.0', edr: '0.24.0' };

/** @type {Record<string, any>} */
export const targets = {
  anvil: {
    title: 'Anvil',
    status: 'run',
    runs: 'local',
    version: ANVIL_RELEASE.version,
    source: 'https://github.com/foundry-rs/foundry',
    // Fixed after v1.8.5, in nightlies only: the nonce race of concurrent eth_sendTransaction and the Celo 0x7b type.
    known: ['foundry#17354', 'foundry#17462'],
    start: { command: 'anvil --host 127.0.0.1 --port 18555', verified: false },
  },
  'anvil-nightly': {
    title: 'Anvil nightly',
    status: 'run',
    runs: 'local',
    // The row of a nightly, for a fix that is in nightlies only; the run names the tag, and the row its date.
    version: null,
    source: 'https://github.com/foundry-rs/foundry',
    known: [],
    start: { command: 'anvil --host 127.0.0.1 --port 18555', verified: false },
  },
  hardhat: {
    title: 'Hardhat (EDR)',
    status: 'run',
    runs: 'local',
    version: HARDHAT.version,
    edr: HARDHAT.edr,
    source: 'https://github.com/NomicFoundation/edr',
    known: ['edr#1258'],
    start: {
      command: 'hardhat node --network l1 --hostname 127.0.0.1 --port 18555',
      verified: false,
    },
  },
  reth: {
    title: 'Reth --dev',
    status: 'run',
    runs: 'docker',
    version: '2.8.0',
    source: 'https://github.com/paradigmxyz/reth',
    image: 'ghcr.io/paradigmxyz/reth:v2.8.0',
    // The index digest, from ghcr.io on 2026-10-21; its entrypoint is /usr/local/bin/reth-binary.
    digest: 'sha256:796c866410171459946d6607301ad728a1b150ea0aa05623cf6bdf79cd3e3322',
    volume: { name: 'data', path: '/data' },
    // From crates/node/core/src/args/ at v2.8.0: --dev (dev.rs:25, prefunds the well-known mnemonic), discovery off by
    // default with --dev (network.rs:930, passed anyway), --http.addr/--http.port/--http.api (rpc_server.rs:455-497),
    // --ipcdisable (rpc_server.rs:525), --datadir (datadir_args.rs:19).
    command: [
      'node',
      '--dev',
      '--datadir',
      '/data',
      '--disable-discovery',
      '--http',
      '--http.addr',
      '0.0.0.0',
      '--http.port',
      String(RPC_PORT),
      '--http.api',
      'eth,net,web3,debug,trace,txpool',
      '--ipcdisable',
    ],
    known: [],
    start: { verified: false },
  },
  geth: {
    title: 'Geth --dev',
    status: 'run',
    runs: 'docker',
    version: '1.17.8',
    source: 'https://github.com/ethereum/go-ethereum',
    image: 'ethereum/client-go:v1.17.8',
    // The index digest, from Docker Hub on 2026-10-21; its entrypoint is geth.
    digest: 'sha256:abf3605177f8bdcfce436985a8054cca4ae59256323a4ffb72c56c04f3d1fadd',
    // From cmd/utils/flags.go at v1.17.8: --dev and --dev.period (163-172; 0 mines only when a transaction is
    // pending), --nodiscover (932), --maxpeers (892), --http/--http.addr/--http.api (764-793), --ipcdisable (754). With
    // no --datadir the dev chain stays in memory (flags.go:1622). It prefunds one faucet only, so the setup funds the
    // well-known accounts from it.
    command: [
      '--dev',
      '--dev.period',
      '0',
      '--nodiscover',
      '--maxpeers',
      '0',
      '--http',
      '--http.addr',
      '0.0.0.0',
      '--http.port',
      String(RPC_PORT),
      '--http.api',
      'eth,net,web3,debug,txpool',
      '--ipcdisable',
    ],
    fundsFromFaucet: true,
    known: [],
    start: { verified: false },
  },
  nethermind: {
    title: 'Nethermind (spaceneth)',
    status: 'phase-2',
    version: '2.2.0',
    source: 'https://github.com/NethermindEth/nethermind',
    note: 'after the gate, if it fits in 2 GiB: a custom chainspec for the well-known accounts, blobs enabled by config',
    known: [],
  },
  besu: {
    title: 'Besu',
    status: 'out',
    source: 'https://github.com/besu-eth/besu',
    note: 'its built-in dev network is London only: no Cancun or Prague, so no EIP-4844 and no EIP-7702',
    known: [],
  },
  ganache: {
    title: 'Ganache',
    status: 'out',
    source: 'https://github.com/trufflesuite/ganache',
    note: 'archived on 2024-01-29, last release v7.9.0 (2023)',
    known: [],
  },
};

/**
 * The targets a run can start.
 * @returns {[string, any][]}
 */
export const runnable = () => Object.entries(targets).filter(([, def]) => def.status === 'run');

/** Container name of a node. */
export const containerOf = (name) => `${PREFIX}${name}`;
/** The named volume of a node, if it has one. */
export const volumeOf = (name, def) =>
  def.volume ? { name: `${PREFIX}${name}-${def.volume.name}`, path: def.volume.path } : undefined;
/** The image reference a run pulls: by digest. */
export const imageRef = (def) => `${def.image.replace(/:[^/:]+$/, '')}@${def.digest}`;

/** `docker run` arguments of a Docker node. */
export function dockerArgs(name, def) {
  if (def.runs !== 'docker') throw new Error(`${name} runs as a local process, not in Docker`);
  const volume = volumeOf(name, def);
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerOf(name),
    `--memory=${MEMORY}`,
    '--publish',
    `127.0.0.1:${HOST_PORT}:${RPC_PORT}`,
    ...(volume ? ['--volume', `${volume.name}:${volume.path}`] : []),
    imageRef(def),
    ...def.command,
  ];
}

/** Arguments of a local Anvil, with a chain mode's arguments after them. */
export const anvilArgs = (mode = []) => [
  '--host',
  '127.0.0.1',
  '--port',
  String(HOST_PORT),
  ...mode,
];

/** Arguments of `hardhat node` for one network of the generated config. */
export const hardhatArgs = (network = 'l1') => [
  'node',
  '--network',
  network,
  '--hostname',
  '127.0.0.1',
  '--port',
  String(HOST_PORT),
];

/**
 * The package.json of the scratch project Hardhat runs from: the exact Hardhat version, with an npm override that
 * replaces the EDR it pins by the one the matrix runs.
 */
export const hardhatPackage = () => ({
  name: 'e15-hardhat',
  private: true,
  type: 'module',
  dependencies: { hardhat: HARDHAT.version },
  overrides: { '@nomicfoundation/edr': HARDHAT.edr },
});

/** The Hardhat config of the scratch project: an L1 network and an OP one (the chain-mode section). */
export const HARDHAT_CONFIG = `export default {
  networks: {
    l1: { type: 'edr-simulated', chainType: 'l1', chainId: 31337 },
    op: { type: 'edr-simulated', chainType: 'op', chainId: 10 },
  },
};
`;

/** The platform part of a Foundry archive name for this host, or undefined when Foundry ships none. */
export function foundryPlatform(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { arm64: 'arm64', x64: 'amd64' }[arch];
  return os && cpu ? `${os}_${cpu}` : undefined;
}

/** The archive name of a Foundry release (`v1.8.5`) or nightly tag (`nightly-<commit>`) for a platform. */
export const foundryArchive = (tag, platform) =>
  tag.startsWith('nightly')
    ? `foundry_nightly_${platform}.tar.gz`
    : `foundry_${tag}_${platform}.tar.gz`;

/**
 * Checks a downloaded archive: its SHA-256 must equal every checksum given (the pinned one, the release's `.sha256`
 * file, the digest the release API lists). Throws when one differs or none is given.
 */
export function checkArchive(sha256, { pinned, file, digest } = {}) {
  const fromFile = file?.trim().split(/\s+/)[0];
  const fromDigest = digest?.replace(/^sha256:/, '');
  const expected = [pinned, fromFile, fromDigest].filter(Boolean);
  if (expected.length === 0) throw new Error('no checksum to check the archive against');
  for (const value of expected) {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('a checksum is not a SHA-256 in hex');
    if (value !== sha256) throw new Error('the archive does not match its checksum');
  }
  return expected.length;
}

/** The version and commit `anvil --version` prints. */
export function anvilVersion(output) {
  return {
    version: /Version: (\S+)/.exec(output)?.[1],
    commit: /Commit SHA: ([0-9a-f]{40})/.exec(output)?.[1],
  };
}

/** The date of a Foundry nightly from its release name, `Nightly (2026-10-21)`. */
export const nightlyDate = (name) => /\((\d{4}-\d{2}-\d{2})\)/.exec(String(name))?.[1];
