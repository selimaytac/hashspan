// Tests the wave-2 side of the facilitator matrix (scripts/facilitators/) without Docker: the two Rust facilitators'
// pinned commits and recorded facts, the config files the harness generates for them, their Dockerfiles, the bearer
// token of a run, the contracts their start needs, and a run of another ref (a pull request head) with its result
// fields and table row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRACTS, VALIDATOR_6492_ADDRESS } from '../../../scripts/facilitators/chain.mjs';
import { ACCOUNTS, NETWORK } from '../../../scripts/facilitators/corpus.mjs';
import { KNOWN } from '../../../scripts/facilitators/diff.mjs';
import {
  buildResult,
  resultFile,
  resultProblems,
  resultTarget,
  resultText,
} from '../../../scripts/facilitators/result.mjs';
import { table, targetLabel } from '../../../scripts/facilitators/table.mjs';
import {
  authHeaders,
  configOf,
  FACILITATOR_PORT,
  facilitatorArgs,
  imageOf,
  KEY_ENV,
  newRunToken,
  parseRef,
  QNTX_COMMIT,
  refTarget,
  secretEnv,
  secretNames,
  settleTimeoutOf,
  targets,
  wave,
  X402_RS_COMMIT,
} from '../../../scripts/facilitators/targets.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, 'scripts/facilitators', path), 'utf8');
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

const PROXY_URL = 'http://127.0.0.1:41234';
const TOKEN = 'f'.repeat(64);
const rust = wave(2);
/** The config file of a target that has one. */
const config = (name: string) => configOf(name) as { file: string; text: string };
/** A file:line source, or a crate's file:line with its name and version first. */
const SOURCE = /^(r402-[a-z]+ \d+\.\d+\.\d+ )?[\w./-]+\.(rs|toml):\d+/;
/** A further line or range of the file named before it (`provider.rs:38-44, 199`). */
const MORE_LINES = /^\d+(-\d+)?( \(.*)?$/;
/** The parts of a source string: each a file:line, or more lines of the file before it. */
const sources = (text: string) =>
  text
    .replace(/ \([^)]*\)/g, '')
    .split(/[,;] /)
    .map((s) => s.replace(/^\w+: /, '').trim());
/** Checks a source string: it starts with a file:line, and every part is one or names more lines of one. */
function expectSource(text: string) {
  const parts = sources(text);
  expect(parts[0]).toMatch(SOURCE);
  for (const part of parts) expect(SOURCE.test(part) || MORE_LINES.test(part), part).toBe(true);
}

describe('wave-2 targets', () => {
  it('pins each Rust facilitator to the commit of its latest release tag', () => {
    expect(X402_RS_COMMIT).toBe('0b14f39afb604a7df25b3496ba34122bdca45a7f');
    expect(QNTX_COMMIT).toBe('de13a74d5cd26d4fdd716af3df91b5436cc2c7e3');
    expect(targets['x402-rs']).toMatchObject({
      repo: 'https://github.com/x402-rs/x402-rs',
      commit: X402_RS_COMMIT,
      release: { tag: 'v2.0.2', date: '2026-07-12' },
      language: 'Rust',
    });
    expect(targets.qntx).toMatchObject({
      repo: 'https://github.com/qntx/facilitator',
      commit: QNTX_COMMIT,
      release: { tag: 'v0.7.1', date: '2026-09-05' },
      language: 'Rust',
    });
    // The receipt-hang class of the fault pass is filed upstream for both already.
    expect(targets['x402-rs'].known).toEqual(['x402-rs#136']);
    expect(targets.qntx.known).toEqual(['qntx#73']);
    for (const [, def] of rust) for (const k of def.known) expect(KNOWN).toContain(k);
  });

  it('archives what cargo needs and nothing that changes the toolchain', () => {
    // x402-rs: every workspace member and the aptos patch path, or cargo does not load the workspace.
    expect(targets['x402-rs'].archive).toEqual([
      'Cargo.toml',
      'Cargo.lock',
      'crates',
      'facilitator',
      'examples',
      'patches',
    ]);
    // qntx: no rust-toolchain.toml, whose stable channel would make rustup fetch another toolchain.
    expect(targets.qntx.archive).toEqual(['Cargo.toml', 'Cargo.lock', 'crates']);
    expect(targets.qntx.crates['r402-evm']).toEqual({
      version: '0.20.0',
      sha256: 'ef9be187aaf1525bd4e487293805ef4170390cde97ec93c015919f89e923f274',
    });
  });

  it.each(rust)(
    '%s records its RPC, chain id, receipt wait and schemes with source lines',
    (_n, def) => {
      expect(def.rpc.env).toBe('EVM_RPC_URL');
      expect(def.rpc.key).toContain('EVM_RPC_URL');
      // Neither falls back to a public RPC: the run's proxy URL is the only one they can use.
      expect(def.rpc.fallback).toMatch(/^none: /);
      expect(def.rpc.checkedAt).toBe(def.commit);
      for (const field of [
        def.rpc.source,
        def.chainId.source,
        def.chainId.customAssetSource,
        def.receiptWait.source,
        def.supported.source,
        def.listen.source,
        def.config.source,
        def.requiredContracts.source,
      ]) {
        expectSource(field);
      }
      expect(def.chainId.customAsset).toMatch(/^yes: /);
      expect(def.listen.address).toBe('0.0.0.0');
      expect(def.start.verified).toBe(false);
      expect(settleTimeoutOf(def)).toBeGreaterThan(def.receiptWait.ms);
    },
  );

  it('expects the schemes each Rust facilitator offers on /supported', () => {
    expect(targets['x402-rs'].supported.schemes).toEqual(['exact', 'upto']);
    expect(targets.qntx.supported.schemes).toEqual(['batch-settlement', 'exact', 'upto']);
  });

  it('installs on Anvil every contract a target checks for at its start', () => {
    const installed = (CONTRACTS as [string, string][]).map(([address]) => address.toLowerCase());
    for (const [, def] of rust) {
      for (const address of def.requiredContracts.addresses) {
        expect(installed).toContain(address.toLowerCase());
      }
    }
    // The EIP-6492 validator is a stub that reverts: the corpus has no EIP-6492 signature that would call it.
    expect(CONTRACTS).toContainEqual([VALIDATOR_6492_ADDRESS, '0x60006000fd']);
  });
});

describe('wave-2 config files', () => {
  it('generates the x402-rs JSON for 84532, listening on 0.0.0.0, RPC and key by env name', () => {
    const { file, text } = config('x402-rs');
    expect(file).toBe('hashspan-facilitator.json');
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      port: FACILITATOR_PORT.container,
      host: '0.0.0.0',
      chains: {
        'eip155:84532': {
          eip1559: true,
          flashblocks: false,
          signers: ['$FACILITATOR_EVM_PRIVATE_KEY'],
          rpc: [{ http: '$EVM_RPC_URL' }],
        },
      },
      schemes: [
        { id: 'v2-eip155-exact', chains: 'eip155:84532' },
        { id: 'v2-eip155-upto', chains: 'eip155:84532' },
      ],
    });
    expect(NETWORK).toBe('eip155:84532');
  });

  it('generates the qntx TOML for 84532 with a bearer for its 0.0.0.0 listen, RPC and key by env name', () => {
    const { file, text } = config('qntx');
    expect(file).toBe('hashspan-facilitator.toml');
    const lines = text.split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        '[http]',
        `listen = "0.0.0.0:${FACILITATOR_PORT.container}"`,
        '[http.auth]',
        'bearer_env = "FACILITATOR_API_TOKEN"',
        '[signer.evm_hot]',
        'source = "env"',
        'env = "FACILITATOR_EVM_PRIVATE_KEY"',
        '[network."eip155:84532"]',
        'rpc_env = "EVM_RPC_URL"',
        'signers = ["evm_hot"]',
        'schemes = ["batch-settlement", "exact", "upto"]',
      ]),
    );
    // One network only, and no literal RPC list next to rpc_env (qntx needs exactly one of the two).
    expect(lines.filter((l: string) => l.startsWith('[network.'))).toHaveLength(1);
    expect(text).not.toMatch(/^rpc = /m);
  });

  it.each(['x402-rs', 'qntx'])('%s config holds no key, token, address or URL', (name) => {
    const { text } = config(name);
    expect(text).not.toContain(ACCOUNTS.facilitator.slice(2));
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('127.0.0.1');
  });

  it('has no config for the wave-1 targets, which take everything from env', () => {
    for (const [name] of wave(1)) expect(configOf(name)).toBeUndefined();
  });

  it.each(rust)(
    '%s copies its config into the image at build time and starts with it',
    (name, def) => {
      const dockerfile = read(`docker/${def.dockerfile}`);
      expect(dockerfile).toContain(`COPY ${config(name).file} ${def.config.image}\n`);
      const cmd = dockerfile.split('\n').find((l: string) => l.startsWith('CMD '));
      expect(cmd).toContain(def.config.image);
      // Build and run stage on the same Debian release, so the binary finds the glibc it was linked with.
      const froms = dockerfile.split('\n').filter((l: string) => l.startsWith('FROM '));
      expect(froms).toHaveLength(2);
      const release = (l: string) => /(bookworm|trixie)/.exec(l)?.[1];
      expect(release(froms[0] as string)).toBeDefined();
      expect(release(froms[0] as string)).toBe(release(froms[1] as string));
      expect(dockerfile).toMatch(/^ENV CARGO_BUILD_JOBS=2$/m);
      const instructions = dockerfile.split('\n').filter((l: string) => l && !l.startsWith('#'));
      expect(instructions.join('\n')).not.toContain('rust-toolchain');
      // A container of the image mounts nothing: the run arguments have no volume (facilitators-harness.test.ts).
      const args = facilitatorArgs(name, def, PROXY_URL);
      expect(args.some((a) => /^(-v|--volume|--mount)/.test(a))).toBe(false);
    },
  );
});

describe('bearer token of a run', () => {
  it('is random per run and never part of the docker arguments', () => {
    const a = newRunToken();
    const b = newRunToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    const args = facilitatorArgs('qntx', targets.qntx, PROXY_URL);
    expect(values(args, '--env')).toContain('FACILITATOR_API_TOKEN');
    expect(args.join(' ')).not.toContain(a);
    expect(secretNames(targets.qntx)).toEqual([KEY_ENV, 'FACILITATOR_API_TOKEN']);
    expect(secretNames(targets['x402-rs'])).toEqual([KEY_ENV]);
  });

  it('goes to qntx through the docker environment and in every call header, and to no other target', () => {
    expect(secretEnv(targets.qntx, TOKEN)).toEqual({
      FACILITATOR_EVM_PRIVATE_KEY: ACCOUNTS.facilitator,
      FACILITATOR_API_TOKEN: TOKEN,
    });
    expect(() => secretEnv(targets.qntx, undefined)).toThrow('bearer token');
    expect(authHeaders(targets.qntx, TOKEN)).toEqual({ authorization: `Bearer ${TOKEN}` });
    for (const name of ['typescript', 'go', 'python', 'x402-rs']) {
      expect(secretEnv(targets[name], TOKEN)).toEqual({
        FACILITATOR_EVM_PRIVATE_KEY: ACCOUNTS.facilitator,
      });
      expect(authHeaders(targets[name], TOKEN)).toEqual({});
    }
  });

  it('is never in a result: the target block names env variables only, and a leak fails the write check', () => {
    const target = resultTarget('qntx', targets.qntx, settleTimeoutOf(targets.qntx));
    const text = JSON.stringify(target);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNTS.facilitator.slice(2));
    expect(resultProblems(`{"t":"${TOKEN}"}`, [TOKEN])).toEqual(['a host value']);
  });
});

describe('a run of another ref', () => {
  const PR_HEAD = 'c6a8680d28e79a1b217796fac0227abcfa6d4612';

  it('takes a ref with a pull request number, and refuses one that could be an option or a path', () => {
    expect(parseRef('pull/138/head')).toEqual({ ref: 'pull/138/head', pr: 138 });
    expect(parseRef('pull/140/head')).toEqual({ ref: 'pull/140/head', pr: 140 });
    expect(parseRef('refs/heads/main')).toEqual({ ref: 'refs/heads/main', pr: null });
    for (const bad of ['', '-x', '--upload-pack=x', 'a..b', 'a b', 'pull/138/head;x', undefined]) {
      expect(() => parseRef(bad as string)).toThrow('--ref');
    }
  });

  it('builds a separately tagged image and writes <target>@<short sha>.json', () => {
    const def = refTarget(targets['x402-rs'], 'pull/138/head', PR_HEAD);
    expect(def).toMatchObject({
      commit: PR_HEAD,
      ref: 'pull/138/head',
      pr: 138,
      baseCommit: X402_RS_COMMIT,
    });
    expect(imageOf('x402-rs', def.commit)).toBe('e14-x402-rs:c6a8680d28e7');
    expect(imageOf('x402-rs', def.commit)).not.toBe(imageOf('x402-rs', X402_RS_COMMIT));
    expect(resultFile('x402-rs', def.commit)).toBe('x402-rs@c6a8680d.json');
    expect(resultFile('x402-rs', X402_RS_COMMIT)).toBe('x402-rs@0b14f39a.json');
    expect(facilitatorArgs('x402-rs', def, PROXY_URL)).toContain('e14-x402-rs:c6a8680d28e7');
    // The pinned entry is unchanged.
    expect(targets['x402-rs'].commit).toBe(X402_RS_COMMIT);
    expect(() => refTarget(targets['x402-rs'], 'pull/138/head', 'c6a8680d')).toThrow('full commit');
  });

  it('records the ref, its pull request and the pinned commit, with the facts read at that commit', () => {
    const def = refTarget(targets['x402-rs'], 'pull/138/head', PR_HEAD);
    const target = resultTarget('x402-rs', def, settleTimeoutOf(def));
    expect(target).toMatchObject({
      name: 'x402-rs',
      commit: PR_HEAD,
      ref: 'pull/138/head',
      pr: 138,
      baseCommit: X402_RS_COMMIT,
      release: { tag: 'v2.0.2', date: '2026-07-12' },
      rpc: { env: 'EVM_RPC_URL', fallback: expect.stringMatching(/^none: /) },
      receiptWait: { ms: 30_000, readAt: X402_RS_COMMIT },
      settleTimeoutMs: 60_000,
      start: { verified: true },
    });
    expect(target.chainId.customAsset).toMatch(/^yes: /);
    const pinned = resultTarget('x402-rs', targets['x402-rs'], 60_000);
    expect(pinned.ref).toBeUndefined();
    expect(pinned.receiptWait.readAt).toBeUndefined();
  });

  it('shows a pull request head as a row of its own next to the pinned commit', () => {
    const result = (target: Record<string, unknown>) =>
      buildResult({
        corpus: { id: 'x402-v2-anvil-1', sha256: 'a'.repeat(64) },
        harness: { commit: 'b'.repeat(40) },
        target,
        anvil: { image: 'ghcr.io/foundry-rs/foundry:v1.8.4', digest: null, chainId: 84532 },
        runDate: '2026-10-22',
        supported: ['exact', 'upto'],
        egress: { conformanceRequests: 3, faultCasesWithoutRequests: 0 },
        conformance: [],
        faults: [],
      });
    const base = result(resultTarget('x402-rs', targets['x402-rs'], 60_000));
    const head = result(
      resultTarget('x402-rs', refTarget(targets['x402-rs'], 'pull/138/head', PR_HEAD), 60_000),
    );
    expect(resultProblems(resultText(head))).toEqual([]);
    expect(targetLabel(base.target)).toBe('x402-rs x402-facilitator');
    expect(targetLabel(head.target)).toBe('x402-rs x402-facilitator (PR #138 head)');
    expect(
      targetLabel({ title: 'x402-rs x402-facilitator', ref: 'refs/heads/main', pr: null }),
    ).toBe('x402-rs x402-facilitator (ref refs/heads/main)');
    const text = table([
      { file: 'x402-rs@0b14f39a.json', result: base },
      { file: 'x402-rs@c6a8680d.json', result: head },
    ]);
    expect(text).toContain('| x402-rs x402-facilitator | `0b14f39a` |');
    expect(text).toContain('| x402-rs x402-facilitator (PR #138 head) | `c6a8680d` |');
    expect(text).toContain(
      '| Case | Field | Spec | x402-rs x402-facilitator | x402-rs x402-facilitator (PR #138 head) |',
    );
  });
});
