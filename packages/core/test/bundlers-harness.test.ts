// Tests the Docker side of the ERC-4337 bundler matrix (scripts/bundlers/) without running Docker or any bundler: the
// targets and their recorded facts, the docker run arguments of every container (0.0.0.0 inside the namespace,
// 127.0.0.1 publishes only), the Dockerfiles, the Rundler release pin and its signature check, the Alto submodule
// list, the faults-proxy runner and the fault scenarios.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, CHAIN_ID, ENTRY_POINTS } from '../../../scripts/bundlers/corpus.mjs';
import {
  FAULT_CASE,
  FAULT_METHODS,
  FAULT_STEPS,
  faultScenarios,
} from '../../../scripts/bundlers/faults.mjs';
import { parseSubmodules } from '../../../scripts/bundlers/images.mjs';
import {
  checkDigest,
  checkSignatureIssuer,
  dearmor,
  downloadRundler,
  RUNDLER_RELEASE,
  rundlerArch,
  sha256,
  signatureInfo,
  validSignatureFingerprint,
} from '../../../scripts/bundlers/rundler.mjs';
import {
  ANVIL,
  anvilArgs,
  BUNDLER_PORT,
  bundlerArgs,
  bundlerUrl,
  containerOf,
  DOCKER_NETWORK,
  imageOf,
  LISTEN_HOST,
  listenHostOf,
  MEMORY,
  PREFIX,
  proxyArgs,
  RECEIPT_MARGIN_MS,
  receiptTimeoutOf,
  secretEnv,
  targets,
  wave,
} from '../../../scripts/bundlers/targets.mjs';
import { parseScenario } from '../../../scripts/facilitators/faults-runner/scenario.mjs';
import { ANVIL as E14_ANVIL, FACILITATOR_PORT } from '../../../scripts/facilitators/targets.mjs';
import { HOST_PORT as E15_PORT } from '../../../scripts/nodes/targets.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, 'scripts/bundlers');
const read = (path: string) => readFileSync(join(dir, path), 'utf8');
const fixtures = join(root, 'packages/core/test/fixtures/rundler-v0.11.0');
const asc = (arch: string) =>
  readFileSync(join(fixtures, `rundler-v0.11.0-${arch}-unknown-linux-gnu.tar.gz.asc`), 'utf8');

/** Values of one flag in a docker argument list. */
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

const PROXY_URL = 'http://127.0.0.1:41234';
const runnable = wave(1);

/** The docker options of a `docker run`, before its image (the bundler's own flags come after it). */
const options = (args: string[], image: string) => args.slice(0, args.indexOf(image) + 1);

/** Every docker run of one target's run: Anvil, the proxy and the bundler, by their docker options. */
const allArgs = (name: string) => [
  { role: 'anvil', args: options(anvilArgs(), ANVIL.image) },
  { role: 'proxy', args: proxyArgs({}, imageOf('faults', 'abc1234567890')) },
  {
    role: 'bundler',
    args: options(bundlerArgs(name, targets[name], PROXY_URL), imageOf(name, targets[name].commit)),
  },
];

describe('bundler matrix targets', () => {
  it('runs Rundler, Alto and Voltaire in wave 1, Skandha later, eth-infinitism as reference, Silius not', () => {
    expect(Object.keys(targets)).toEqual([
      'rundler',
      'alto',
      'voltaire',
      'skandha',
      'eth-infinitism',
      'silius',
    ]);
    expect(runnable.map(([name]) => name)).toEqual(['rundler', 'alto', 'voltaire']);
    expect(Object.fromEntries(runnable.map(([n, d]) => [n, d.version]))).toEqual({
      rundler: 'v0.11.0',
      alto: 'v1.2.8',
      voltaire: 'v1.0.5',
    });
    expect(targets.skandha).toMatchObject({ wave: 2, notYetRun: true, version: 'v2-2.4.6' });
    expect(targets['eth-infinitism']).toMatchObject({ wave: 'reference', notYetRun: true });
    expect(targets.silius).toMatchObject({ wave: 'out', notYetRun: true });
    expect(targets.silius.note).toMatch(/^out: /);
    for (const name of ['skandha', 'eth-infinitism', 'silius']) {
      expect(() => bundlerArgs(name, targets[name], PROXY_URL)).toThrow('not run');
    }
    for (const [, def] of runnable) {
      expect(def.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(def.repo).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/);
    }
    expect(targets.rundler.repo).toBe('https://github.com/alchemyplatform/rundler');
  });

  it.each(runnable)(
    '%s runs unsafe, without a tracer, with the flag and its source line',
    (_n, def) => {
      expect(def.unsafe.source).toMatch(/:\d+/);
      const command = def.command(PROXY_URL).join(' ');
      expect(command).toContain(def.unsafe.flag);
      expect(command).not.toMatch(/debug_trace|tracer/i);
      expect(def.start.verified).toBe(false);
    },
  );

  it.each(runnable)(
    '%s listens on 0.0.0.0 inside the namespace, with the source of that',
    (_n, def) => {
      expect(LISTEN_HOST).toBe('0.0.0.0');
      expect(listenHostOf(def)).toBe('0.0.0.0');
      expect(def.listen.source).toMatch(/:\d+/);
      const command = def.command(PROXY_URL);
      const port =
        values(command, '--rpc.port')[0] ??
        values(command, '--port')[0] ??
        values(command, '--rpc_port')[0];
      expect(port).toBe(String(BUNDLER_PORT.container));
    },
  );

  it('keeps Rundler metrics on the loopback of the namespace and enables EntryPoint v0.7 only', () => {
    const command = targets.rundler.command(PROXY_URL);
    expect(values(command, '--metrics.host')).toEqual(['127.0.0.1']);
    expect(values(command, '--enabled_entry_points')).toEqual(['v0.7']);
    expect(values(command, '--network')).toEqual(['dev']);
    expect(values(targets.alto.command(PROXY_URL), '--entrypoints')).toEqual([ENTRY_POINTS['0.7']]);
    expect(values(targets.voltaire.command(PROXY_URL), '--chain_id')).toEqual([String(CHAIN_ID)]);
    // --debug would stop Voltaire's automatic bundling.
    expect(targets.voltaire.command(PROXY_URL)).not.toContain('--debug');
  });

  it.each(runnable)(
    '%s waits for a receipt its bundle interval plus a margin, with the source named',
    (_n, def) => {
      expect(def.bundleInterval.ms).toBeGreaterThan(0);
      expect(def.bundleInterval.source).toMatch(/:\d+/);
      expect(receiptTimeoutOf(def)).toBe(def.bundleInterval.ms + RECEIPT_MARGIN_MS);
      expect(RECEIPT_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
    },
  );

  it.each(runnable)(
    '%s runs its containers removable, named e16-, with 2 GiB, and no host path',
    (name) => {
      expect(PREFIX).toBe('e16-');
      expect(MEMORY).toBe('2g');
      for (const { role, args } of allArgs(name)) {
        expect({ role, start: args.slice(0, 3) }).toEqual({
          role,
          start: ['run', '--detach', '--rm'],
        });
        expect(values(args, '--name')[0]).toMatch(/^e16-[a-z0-9-]+$/);
        expect(args).toContain(`--memory=${MEMORY}`);
        expect(args.some((a) => ['-v', '-p', '--volume', '--mount'].includes(a))).toBe(false);
        const text = args.join(' ');
        expect(text).not.toContain(homedir());
        expect(text).not.toMatch(/\/Users\/|\/home\/|\/root\//);
      }
      expect(containerOf(name)).toBe(`e16-${name}`);
    },
  );

  it('gives Anvil the namespace: an e16- network, DNS to 127.0.0.1, publishes on 127.0.0.1 only', () => {
    const args = anvilArgs();
    expect(DOCKER_NETWORK).toBe('e16-net');
    expect(values(args, '--name')).toEqual(['e16-anvil']);
    expect(values(args, '--network')).toEqual(['e16-net']);
    expect(values(args, '--dns')).toEqual(['127.0.0.1']);
    const ports = values(args, '--publish');
    expect(ports).toEqual([
      `127.0.0.1:${ANVIL.hostPort}:${ANVIL.port}`,
      `127.0.0.1:${BUNDLER_PORT.host}:${BUNDLER_PORT.container}`,
    ]);
    for (const p of ports) expect(p.startsWith('127.0.0.1:')).toBe(true);
    const command = args.slice(args.indexOf(ANVIL.image) + 1);
    expect(command).toEqual([
      '--host',
      '0.0.0.0',
      '--port',
      String(ANVIL.port),
      '--chain-id',
      '1337',
      '--code-size-limit',
      '100000000',
    ]);
  });

  it('uses host ports of its own, apart from the facilitator and dev-node matrices', () => {
    const ours = [ANVIL.hostPort, BUNDLER_PORT.host];
    const theirs = [E14_ANVIL.hostPort, FACILITATOR_PORT.host, E15_PORT];
    for (const port of ours) expect(theirs).not.toContain(port);
  });

  it.each(runnable)(
    '%s joins Anvil with --network container:, publishing nothing of its own',
    (name) => {
      for (const { role, args } of allArgs(name).filter((a) => a.role !== 'anvil')) {
        expect({ role, network: values(args, '--network') }).toEqual({
          role,
          network: ['container:e16-anvil'],
        });
        for (const flag of ['--publish', '--dns', '--hostname', '--entrypoint']) {
          expect({ role, flag, has: args.includes(flag) }).toEqual({ role, flag, has: false });
        }
      }
    },
  );

  it.each(runnable)(
    '%s takes its node from the proxy on 127.0.0.1 and its keys by name only',
    (name, def) => {
      const args = bundlerArgs(name, def, PROXY_URL);
      const env = values(args, '--env');
      expect(env).toEqual(Object.keys(def.keys));
      for (const role of Object.values(def.keys) as string[]) {
        expect(args.join(' ')).not.toContain((ACCOUNTS as Record<string, string>)[role]?.slice(2));
      }
      expect(Object.values(secretEnv(def))).toEqual(
        (Object.values(def.keys) as string[]).map((r) => (ACCOUNTS as Record<string, string>)[r]),
      );
      expect(def.command(PROXY_URL)).toContain(PROXY_URL);
      expect(() => bundlerArgs(name, def, 'http://anvil:8545')).toThrow('127.0.0.1');
      expect(args).toContain(imageOf(name, def.commit));
      expect(def.keysSource).toMatch(/:\d+/);
    },
  );

  it('keeps the executor, utility and owner keys apart', () => {
    expect(secretEnv(targets.rundler)).toEqual({ SIGNER_PRIVATE_KEYS: ACCOUNTS.executor });
    expect(secretEnv(targets.alto)).toEqual({
      ALTO_EXECUTOR_PRIVATE_KEYS: ACCOUNTS.executor,
      ALTO_UTILITY_PRIVATE_KEY: ACCOUNTS.utility,
    });
    expect(secretEnv(targets.voltaire)).toEqual({ VOLTAIRE_BUNDLER_SECRET: ACCOUNTS.executor });
    expect(new Set(Object.values(ACCOUNTS)).size).toBe(Object.keys(ACCOUNTS).length);
  });

  it('reaches each bundler on its published port and path', () => {
    expect(bundlerUrl(targets.rundler)).toBe('http://127.0.0.1:14337');
    expect(bundlerUrl(targets.alto)).toBe('http://127.0.0.1:14337');
    expect(bundlerUrl(targets.voltaire)).toBe('http://127.0.0.1:14337/rpc');
  });

  it('hands the proxy its scenario and a loopback upstream through env', () => {
    const scenario = { eth_sendRawTransaction: { fault: { kind: 'reset' }, times: 1 } };
    const args = proxyArgs(scenario, 'e16-faults:abc');
    expect(values(args, '--env')).toEqual([
      `FAULT_SCENARIO=${JSON.stringify(scenario)}`,
      `FAULT_UPSTREAM=http://127.0.0.1:${ANVIL.port}`,
    ]);
    expect(values(args, '--name')).toEqual(['e16-faults']);
  });
});

describe('bundler matrix images', () => {
  const dockerfiles = readdirSync(join(dir, 'docker')).filter((f) => f.endsWith('.Dockerfile'));

  it('has one Dockerfile per wave-1 target and one for the proxy runner', () => {
    expect(dockerfiles.sort()).toEqual([
      'alto.Dockerfile',
      'faults.Dockerfile',
      'rundler.Dockerfile',
      'voltaire.Dockerfile',
    ]);
    for (const [name, def] of runnable) expect(def.dockerfile).toBe(`${name}.Dockerfile`);
  });

  it.each(dockerfiles)('%s copies its build context only, with no mount and no URL', (file) => {
    const lines = read(`docker/${file}`)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    for (const line of lines) {
      const instruction = line.split(/\s+/)[0] as string;
      expect(['FROM', 'WORKDIR', 'COPY', 'RUN', 'ENV', 'CMD', 'USER', 'ENTRYPOINT']).toContain(
        instruction,
      );
      expect(line).not.toMatch(/--mount|^ADD\b|https?:\/\/|curl|wget/);
    }
    expect(lines.some((l) => l.startsWith('COPY '))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/PRIVATE_KEY|SECRET|0x[0-9a-f]{64}/i);
  });

  it('puts the checked Rundler binary into a bookworm image', () => {
    const dockerfile = read('docker/rundler.Dockerfile');
    expect(dockerfile).toMatch(/^FROM debian:bookworm-slim$/m);
    expect(dockerfile).toMatch(/^COPY rundler \/usr\/local\/bin\/rundler$/m);
  });

  it('builds Alto with T-0133 limits: full Node.js image, one task at a time, a larger heap, its own package', () => {
    const dockerfile = read('docker/alto.Dockerfile');
    expect(dockerfile).toMatch(/^FROM node:22-bookworm$/m);
    expect(dockerfile).toContain('ENV NODE_OPTIONS=--max-old-space-size=4096');
    expect(dockerfile).toContain('--filter @pimlico/alto... --workspace-concurrency=1');
    expect(dockerfile.match(/^RUN forge build /gm)).toHaveLength(9);
    // Only Alto's package and the manifests its frozen lockfile needs; not the e2e tests or the deployer.
    expect(targets.alto.archive).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'src',
      'contracts',
      'test/e2e/package.json',
      'scripts/localDeployer/package.json',
    ]);
    expect(targets.alto.submodules).toBe('contracts/lib');
  });

  it('builds Voltaire from its hash-pinned requirements on glibc, without the committed p2p binary', () => {
    const dockerfile = read('docker/voltaire.Dockerfile');
    expect(dockerfile).toMatch(/^FROM python:3\.13-slim-bookworm$/m);
    expect(dockerfile).toContain('--require-hashes');
    expect(targets.voltaire.archive).not.toContain('voltaire-p2p');
  });

  it('runs the proxy runner from the built faults package, armed by a signal, remote upstreams refused', () => {
    expect(read('docker/faults.Dockerfile')).toMatch(/COPY node_modules\/@hashspan\/faults /);
    const runner = read('faults-runner/runner.mjs');
    expect(runner).toContain("from '@hashspan/faults'");
    expect(runner).not.toContain('allowRemoteUpstream');
    expect(runner).toContain("process.on('SIGUSR2'");
    expect(runner).not.toContain("process.on('SIGUSR1'");
    // The rules are set once, on the signal, and the counts before it are kept for the egress check.
    expect(runner.match(/proxy\.set\(/g)).toHaveLength(1);
    expect(read('images.mjs')).toContain("'../facilitators/faults-runner/scenario.mjs'");
    expect(read('run.mjs')).toContain("'kill', '--signal', 'SIGUSR2'");
  });

  it('reads the submodules of a commit with their GitHub URL, and refuses anything else', () => {
    const tree = [
      '160000 commit 7af70c8993a6f42973f520ae0752386a5032abe7\tcontracts/lib/account-abstraction-v7',
      '160000 commit ae570fec082bfe1c1f45b0acca4a2b4f84d345ce\tcontracts/lib/forge-std',
      '100644 blob 0123456789012345678901234567890123456789\tcontracts/lib/README.md',
    ].join('\n');
    const modules = [
      '[submodule "contracts/lib/forge-std"]',
      '\tpath = contracts/lib/forge-std',
      '\turl = https://github.com/foundry-rs/forge-std',
      '[submodule "contracts/lib/account-abstraction-v7"]',
      '\tpath = contracts/lib/account-abstraction-v7',
      '\turl = https://github.com/eth-infinitism/account-abstraction',
      '\tbranch = releases/v0.7',
    ].join('\n');
    expect(parseSubmodules(tree, modules)).toEqual([
      {
        path: 'contracts/lib/account-abstraction-v7',
        commit: '7af70c8993a6f42973f520ae0752386a5032abe7',
        url: 'https://github.com/eth-infinitism/account-abstraction',
      },
      {
        path: 'contracts/lib/forge-std',
        commit: 'ae570fec082bfe1c1f45b0acca4a2b4f84d345ce',
        url: 'https://github.com/foundry-rs/forge-std',
      },
    ]);
    expect(() =>
      parseSubmodules(tree, modules.replace('https://github.com/foundry-rs', 'file:///x')),
    ).toThrow('GitHub');
    expect(() => parseSubmodules(tree, '')).toThrow('no URL');
  });
});

describe('Rundler release pin', () => {
  it('pins v0.11.0 of alchemyplatform/rundler, both linux assets and their signatures', () => {
    expect(RUNDLER_RELEASE.repo).toBe('https://github.com/alchemyplatform/rundler');
    expect(RUNDLER_RELEASE.tag).toBe('v0.11.0');
    expect(Object.keys(RUNDLER_RELEASE.assets)).toEqual(['aarch64', 'x86_64']);
    for (const [arch, asset] of Object.entries(RUNDLER_RELEASE.assets)) {
      expect(asset.name).toBe(`rundler-v0.11.0-${arch}-unknown-linux-gnu.tar.gz`);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(Buffer.from(asc(arch)))).toBe(asset.ascSha256);
    }
  });

  it('takes the asset of the Docker VM architecture, never a darwin one', () => {
    expect(rundlerArch('aarch64')).toBe('aarch64');
    expect(rundlerArch('arm64')).toBe('aarch64');
    expect(rundlerArch('x86_64\n')).toBe('x86_64');
    expect(rundlerArch('amd64')).toBe('x86_64');
    expect(() => rundlerArch('darwin')).toThrow('no linux asset');
    expect(() => rundlerArch('riscv64')).toThrow('no linux asset');
  });

  it('checks a digest against its pin', () => {
    const bytes = Buffer.from('rundler');
    expect(() => checkDigest(bytes, sha256(bytes), 'x')).not.toThrow();
    expect(() => checkDigest(bytes, sha256(Buffer.from('other')), 'x')).toThrow('does not match');
    expect(() => checkDigest(bytes, 'abc', 'x')).toThrow('not a SHA-256');
  });

  it.each(['aarch64', 'x86_64'])(
    'reads the issuer of the %s signature and accepts the pinned key',
    (arch) => {
      const info = signatureInfo(asc(arch));
      expect(info).toMatchObject({
        signatureType: 0,
        publicKeyAlgorithm: 1,
        hashAlgorithm: 10,
        issuerFingerprint: RUNDLER_RELEASE.signer.fingerprint,
        issuerKeyId: RUNDLER_RELEASE.signer.keyId,
      });
      expect(new Date((info.created as number) * 1000).toISOString().slice(0, 10)).toBe(
        '2026-02-12',
      );
      expect(checkSignatureIssuer(asc(arch)).issuerFingerprint).toBe(
        RUNDLER_RELEASE.signer.fingerprint,
      );
    },
  );

  it('refuses a signature of another key, a cut one and no signature at all', () => {
    const other = { fingerprint: 'A'.repeat(40), keyId: 'A'.repeat(16) };
    expect(() => checkSignatureIssuer(asc('aarch64'), other)).toThrow('not the pinned key');
    expect(() => dearmor('no armor')).toThrow('not an armored');
    const lines = asc('aarch64').split('\n');
    const cut = [...lines.slice(0, 4), ...lines.slice(-3)].join('\n');
    expect(() => signatureInfo(cut)).toThrow();
    // The release notes name a fingerprint of 39 hex digits, which no signature carries.
    expect(RUNDLER_RELEASE.signer.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(RUNDLER_RELEASE.signer.fingerprint.endsWith(RUNDLER_RELEASE.signer.keyId)).toBe(true);
  });

  it('reads the key of a good signature from gpgv status output', () => {
    const fpr = RUNDLER_RELEASE.signer.fingerprint;
    expect(
      validSignatureFingerprint(
        `[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG ${fpr} 2026-02-12 1770928940\n`,
      ),
    ).toBe(fpr);
    expect(validSignatureFingerprint('[GNUPG:] BADSIG 14D8B18F33C823B0 x\n')).toBeUndefined();
  });

  it('downloads both assets and refuses a tarball that does not match its pin', async () => {
    const signature = Buffer.from(asc('aarch64'));
    const fake = (archive: Buffer) => async (url: string) =>
      new Response(url.endsWith('.asc') ? signature : archive, { status: 200 });
    await expect(
      downloadRundler('aarch64', { fetchImpl: fake(Buffer.from('not rundler')) }),
    ).rejects.toThrow('does not match its pinned SHA-256');
    await expect(downloadRundler('mips', { fetchImpl: fake(Buffer.from('')) })).rejects.toThrow(
      'no pinned',
    );
    const missing = async () => new Response('', { status: 404 });
    await expect(downloadRundler('aarch64', { fetchImpl: missing })).rejects.toThrow('HTTP 404');
  });
});

describe('faults-proxy runner scenario and the fault pass', () => {
  it('parses the rules of every scenario', () => {
    for (const s of faultScenarios()) {
      const rules = parseScenario(JSON.stringify(s.rules));
      expect(Object.keys(rules)).toEqual([s.method]);
      expect(rules[s.method].times).toBe(1);
    }
  });

  it('injects each kind once on the send, the estimates, the receipt read and the simulation calls', () => {
    expect(FAULT_CASE).toBe('plain-op');
    expect(FAULT_STEPS).toEqual(['estimate', 'send', 'wait', 'send', 'wait']);
    expect(FAULT_METHODS).toEqual([
      'eth_sendRawTransaction',
      'eth_estimateGas',
      'eth_getTransactionReceipt',
      'eth_call',
    ]);
    const ids = faultScenarios().map((s: { id: string }) => s.id);
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 5)).toEqual([
      'eth_sendRawTransaction:hang',
      'eth_sendRawTransaction:reset',
      'eth_sendRawTransaction:drop',
      'eth_sendRawTransaction:truncate',
      'eth_sendRawTransaction:rpc-error',
    ]);
    expect(JSON.stringify(faultScenarios())).not.toMatch(/\bbugs?\b/i);
  });
});
