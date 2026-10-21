// Tests the node side of the dev-node matrix (scripts/nodes/) without Docker or a node: the targets and their pinned
// facts, the docker run arguments of Reth and Geth, the local commands of Anvil and Hardhat, the archive checks of the
// Anvil download, the contract the flows deploy and the blob transaction of the EIP-4844 flow.
import { homedir } from 'node:os';
import { fromRlp, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { CHAIN_MODES, modesOf } from '../../../scripts/nodes/chain-modes.mjs';
import {
  CALL,
  CUSTOM_SELECTOR,
  ERROR_SELECTOR,
  INITCODE,
  PING_TOPIC,
  RUNTIME,
} from '../../../scripts/nodes/contract.mjs';
import {
  accountAt,
  BLOB,
  blobWrapper,
  CELLS_PER_BLOB,
  FLOWS,
  ROLES,
  versionedHash,
  ZERO_COMMITMENT,
} from '../../../scripts/nodes/flows.mjs';
import { forkFeatures, methodStatus, NOT_FOUND } from '../../../scripts/nodes/probes.mjs';
import { clientOf, fundFromFaucet } from '../../../scripts/nodes/setup.mjs';
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
  HOST_PORT,
  hardhatArgs,
  hardhatPackage,
  imageRef,
  MEMORY,
  nightlyDate,
  PREFIX,
  RPC_PORT,
  runnable,
  targets,
  volumeOf,
} from '../../../scripts/nodes/targets.mjs';

/** Values of one flag in a docker argument list. */
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

const DOCKER = ['reth', 'geth'];

describe('dev-node targets', () => {
  it('runs Anvil, an Anvil nightly, Hardhat (EDR), Reth and Geth; Nethermind is phase 2, Besu and Ganache out', () => {
    expect(Object.keys(targets)).toEqual([
      'anvil',
      'anvil-nightly',
      'hardhat',
      'reth',
      'geth',
      'nethermind',
      'besu',
      'ganache',
    ]);
    expect(runnable().map(([name]) => name)).toEqual([
      'anvil',
      'anvil-nightly',
      'hardhat',
      'reth',
      'geth',
    ]);
    expect(targets.nethermind.status).toBe('phase-2');
    expect(targets.besu.status).toBe('out');
    // Besu is out for the London-only dev network, nothing else.
    expect(targets.besu.note).toMatch(/London only/);
    expect(targets.besu.note).not.toMatch(/DCO|trailer|contribut/i);
    expect(targets.ganache.note).toMatch(/archived/);
  });

  it('pins each version: Anvil v1.8.5, Hardhat 3.20.0 on EDR 0.24.0, Reth v2.8.0, Geth v1.17.8', () => {
    expect(ANVIL_RELEASE).toMatchObject({ tag: 'v1.8.5', version: '1.8.5' });
    expect(ANVIL_RELEASE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(ANVIL_RELEASE.sha256).sort()).toEqual([
      'darwin_amd64',
      'darwin_arm64',
      'linux_amd64',
      'linux_arm64',
    ]);
    for (const sum of Object.values(ANVIL_RELEASE.sha256)) expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(HARDHAT).toEqual({ version: '3.20.0', edr: '0.24.0' });
    expect(targets.reth).toMatchObject({
      version: '2.8.0',
      image: 'ghcr.io/paradigmxyz/reth:v2.8.0',
    });
    expect(targets.geth).toMatchObject({ version: '1.17.8', image: 'ethereum/client-go:v1.17.8' });
    // The nightly row has no version of its own: the run names the tag and the row its date.
    expect(targets['anvil-nightly'].version).toBeNull();
  });

  it('marks as known only the upstream items the pinned versions have not fixed', () => {
    expect(targets.anvil.known).toEqual(['foundry#17354', 'foundry#17462']);
    expect(targets['anvil-nightly'].known).toEqual([]);
    // edr#1829 is fixed in EDR 0.24.0, so it is a regression row there, not a known difference.
    expect(targets.hardhat.known).toEqual(['edr#1258']);
    expect(targets.reth.known).toEqual([]);
    expect(targets.geth.known).toEqual([]);
    for (const [, def] of runnable()) expect(def.start.verified).toBe(false);
  });
});

describe('docker run arguments', () => {
  it.each(DOCKER)(
    '%s runs removable, named e15-, with 2 GiB and only its HTTP RPC port on 127.0.0.1',
    (name) => {
      const args = dockerArgs(name, targets[name]);
      expect(PREFIX).toBe('e15-');
      expect(MEMORY).toBe('2g');
      expect(args.slice(0, 3)).toEqual(['run', '--detach', '--rm']);
      expect(values(args, '--name')).toEqual([`e15-${name}`]);
      expect(containerOf(name)).toBe(`e15-${name}`);
      expect(args).toContain('--memory=2g');
      expect(values(args, '--publish')).toEqual([`127.0.0.1:${HOST_PORT}:${RPC_PORT}`]);
      for (const flag of [
        '-p',
        '-P',
        '--publish-all',
        '--network',
        '-v',
        '--mount',
        '--privileged',
      ]) {
        expect({ flag, has: args.includes(flag) }).toEqual({ flag, has: false });
      }
      const text = args.join(' ');
      expect(text).not.toContain(homedir());
      expect(text).not.toMatch(/\/Users\/|\/home\/|\/root\//);
    },
  );

  it.each(DOCKER)('%s pulls its image by digest', (name) => {
    const def = targets[name];
    expect(def.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const args = dockerArgs(name, def);
    expect(args).toContain(imageRef(def));
    expect(imageRef(def)).toBe(`${def.image.replace(/:v[\d.]+$/, '')}@${def.digest}`);
    expect(args.some((a: string) => a === def.image)).toBe(false);
  });

  it('gives Reth a named e15- volume for its datadir and no path of the host', () => {
    const args = dockerArgs('reth', targets.reth);
    expect(values(args, '--volume')).toEqual(['e15-reth-data:/data']);
    expect(volumeOf('reth', targets.reth)).toEqual({ name: 'e15-reth-data', path: '/data' });
    const command = args.slice(args.indexOf(imageRef(targets.reth)) + 1);
    expect(command.slice(0, 2)).toEqual(['node', '--dev']);
    expect(values(command, '--datadir')).toEqual(['/data']);
    expect(command).toContain('--disable-discovery');
    expect(command).toContain('--ipcdisable');
    expect(values(command, '--http.addr')).toEqual(['0.0.0.0']);
    expect(values(command, '--http.port')).toEqual([String(RPC_PORT)]);
    expect(command.some((a: string) => /^--(ws|authrpc\.addr|metrics)/.test(a))).toBe(false);
  });

  it('runs Geth --dev in memory, mining per transaction, without discovery or peers', () => {
    const args = dockerArgs('geth', targets.geth);
    expect(values(args, '--volume')).toEqual([]);
    const command = args.slice(args.indexOf(imageRef(targets.geth)) + 1);
    expect(command[0]).toBe('--dev');
    expect(values(command, '--dev.period')).toEqual(['0']);
    expect(command).toContain('--nodiscover');
    expect(values(command, '--maxpeers')).toEqual(['0']);
    expect(command.some((a: string) => a.startsWith('--datadir'))).toBe(false);
    expect(command).toContain('--ipcdisable');
    expect(command.some((a: string) => /^--(ws|authrpc\.addr|metrics)/.test(a))).toBe(false);
    expect(targets.geth.fundsFromFaucet).toBe(true);
  });

  it('refuses to build docker arguments for a local node', () => {
    expect(() => dockerArgs('anvil', targets.anvil)).toThrow('local process');
  });
});

describe('local nodes', () => {
  it('starts Anvil on 127.0.0.1, with a chain mode after its own arguments', () => {
    expect(anvilArgs()).toEqual(['--host', '127.0.0.1', '--port', String(HOST_PORT)]);
    expect(anvilArgs(['--celo'])).toEqual([
      '--host',
      '127.0.0.1',
      '--port',
      String(HOST_PORT),
      '--celo',
    ]);
  });

  it('runs Hardhat from a project that pins it exactly and overrides its EDR', () => {
    expect(hardhatPackage()).toEqual({
      name: 'e15-hardhat',
      private: true,
      type: 'module',
      dependencies: { hardhat: '3.20.0' },
      overrides: { '@nomicfoundation/edr': '0.24.0' },
    });
    expect(hardhatArgs()).toEqual([
      'node',
      '--network',
      'l1',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(HOST_PORT),
    ]);
    expect(hardhatArgs('op')[2]).toBe('op');
    expect(HARDHAT_CONFIG).toContain("chainType: 'l1', chainId: 31337");
    expect(HARDHAT_CONFIG).toContain("chainType: 'op', chainId: 10");
  });

  it('downloads the Foundry archive of the host platform, release or nightly', () => {
    expect(foundryPlatform('darwin', 'arm64')).toBe('darwin_arm64');
    expect(foundryPlatform('linux', 'x64')).toBe('linux_amd64');
    expect(foundryPlatform('win32', 'x64')).toBeUndefined();
    expect(foundryArchive('v1.8.5', 'linux_amd64')).toBe('foundry_v1.8.5_linux_amd64.tar.gz');
    expect(foundryArchive('nightly-9089a6bf', 'darwin_arm64')).toBe(
      'foundry_nightly_darwin_arm64.tar.gz',
    );
    expect(nightlyDate('Nightly (2026-10-21)')).toBe('2026-10-21');
    expect(nightlyDate('v1.8.5')).toBeUndefined();
  });

  it('checks an archive against every checksum given, and refuses one with none', () => {
    const sum = 'a'.repeat(64);
    expect(checkArchive(sum, { pinned: sum })).toBe(1);
    expect(
      checkArchive(sum, {
        pinned: sum,
        file: `${sum}  foundry_v1.8.5_darwin_arm64.tar.gz\n`,
        digest: `sha256:${sum}`,
      }),
    ).toBe(3);
    expect(() => checkArchive(sum, { file: `${'b'.repeat(64)}  x.tar.gz` })).toThrow(
      'does not match',
    );
    expect(() => checkArchive(sum, { pinned: sum, digest: `sha256:${'c'.repeat(64)}` })).toThrow(
      'does not match',
    );
    expect(() => checkArchive(sum, {})).toThrow('no checksum');
    expect(() => checkArchive(sum, { pinned: 'not-hex' })).toThrow('SHA-256');
  });

  it('reads the version and commit Anvil prints', () => {
    const printed = `anvil Version: 1.8.5\nCommit SHA: ${ANVIL_RELEASE.commit}\nBuild Profile: dist\n`;
    expect(anvilVersion(printed)).toEqual({ version: '1.8.5', commit: ANVIL_RELEASE.commit });
    expect(anvilVersion('nothing')).toEqual({ version: undefined, commit: undefined });
  });

  it('records a client by name and version only, without platform or build', () => {
    expect(clientOf('Geth/v1.17.8-stable-abcdef12/linux-arm64/go1.25.1')).toBe(
      'Geth/v1.17.8-stable-abcdef12',
    );
    expect(clientOf('anvil/v1.8.5')).toBe('anvil/v1.8.5');
    expect(clientOf(undefined)).toBe('absent');
  });
});

describe('probes', () => {
  it('calls a method unsupported only when the node says it does not know it', () => {
    expect(NOT_FOUND).toEqual([-32601, -32004]);
    expect(methodStatus({ error: { code: -32601, message: 'Method not found' } })).toBe(
      'unsupported',
    );
    expect(
      methodStatus({ error: { code: -32004, message: 'Method eth_simulateV1 is not supported' } }),
    ).toBe('unsupported');
    // Any other answer, an error included, means the method is there.
    expect(methodStatus({ error: { code: -32001, message: 'transaction not found' } })).toBe(
      'supported',
    );
    expect(methodStatus({ error: { code: -32602, message: 'invalid params' } })).toBe('supported');
    expect(methodStatus({ result: [] })).toBe('supported');
  });

  it('reads EIP-7702 and EIP-4844 from the fork fields of the genesis header', () => {
    expect(forkFeatures({ requestsHash: '0x', excessBlobGas: '0x0' })).toEqual({
      eip7702: 'supported',
      eip4844: 'supported',
    });
    expect(forkFeatures({ excessBlobGas: '0x0' })).toEqual({
      eip7702: 'unsupported',
      eip4844: 'supported',
    });
    expect(forkFeatures({})).toEqual({ eip7702: 'unsupported', eip4844: 'unsupported' });
    expect(forkFeatures(null)).toEqual({ eip7702: 'unsupported', eip4844: 'unsupported' });
  });

  it('probes first every flow that needs a feature', () => {
    const needs = FLOWS.filter((f) => f.needs).map((f) => [f.id, f.needs]);
    expect(needs).toEqual([
      ['block-receipts', 'eth_getBlockReceipts'],
      ['simulate', 'eth_simulateV1'],
      ['trace', 'debug_traceTransaction'],
      ['eip7702', 'eip7702'],
      ['eip4844', 'eip4844'],
      ['concurrent-send', 'eth_sendTransaction'],
    ]);
  });
});

describe('flows', () => {
  it('runs the flows of the design in order', () => {
    expect(FLOWS.map((f: { id: string }) => f.id)).toEqual([
      'deploy',
      'legacy',
      'eip2930',
      'eip1559',
      'logs',
      'revert-reason',
      'custom-error',
      'out-of-gas',
      'estimate-gas',
      'fee-history',
      'block-receipts',
      'simulate',
      'trace',
      'eip7702',
      'eip4844',
      'invalid-input',
      'concurrent-send',
    ]);
  });

  it('signs with the well-known accounts, one per role', () => {
    expect(ROLES).toEqual({ sender: 0, authority: 1, blob: 2, invalid: 3 });
    expect(accountAt(0).address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(accountAt(1).address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('deploys a contract that emits, reverts with a reason and a custom error, and loops', () => {
    expect(PING_TOPIC).toBe(keccak256(new TextEncoder().encode('Ping(uint256)')));
    expect(ERROR_SELECTOR).toBe('0x08c379a0');
    expect(CUSTOM_SELECTOR).toBe(
      keccak256(new TextEncoder().encode('Custom(uint256)')).slice(0, 10),
    );
    expect(CALL).toEqual({ emit: '0x01', reason: '0x02', custom: '0x03', loop: '0x04' });
    expect(INITCODE.endsWith(RUNTIME.slice(2))).toBe(true);
    // PUSH2 <runtime length> PUSH2 <offset> PUSH1 0 CODECOPY PUSH2 <runtime length> PUSH1 0 RETURN, then the runtime.
    const length = (RUNTIME.length - 2) / 2;
    expect(INITCODE.slice(0, 32)).toBe(
      `0x61${length.toString(16).padStart(4, '0')}61000f600039${'61'}${length.toString(16).padStart(4, '0')}6000f3`,
    );
    expect(RUNTIME).toContain(PING_TOPIC.slice(2));
  });

  it('builds the zero-blob transaction without a KZG library', () => {
    expect(BLOB.length).toBe(2 + 131072 * 2);
    expect(ZERO_COMMITMENT).toBe(`0xc0${'00'.repeat(47)}`);
    const hash = versionedHash(ZERO_COMMITMENT);
    expect(hash).toMatch(/^0x01[0-9a-f]{62}$/);
    const signed = `0x03${'c3010203'}`;
    const v1 = fromRlp(`0x${blobWrapper(signed, 'v1').slice(4)}`) as unknown[];
    expect(v1[0]).toEqual(['0x01', '0x02', '0x03']);
    expect(v1[1]).toBe('0x01');
    expect((v1[4] as string[]).length).toBe(CELLS_PER_BLOB);
    const v0 = fromRlp(`0x${blobWrapper(signed, 'v0').slice(4)}`) as unknown[];
    expect(v0.length).toBe(4);
    expect((v0[3] as string[]).length).toBe(1);
    expect(() => blobWrapper('0x02c0', 'v1')).toThrow('blob');
  });
});

describe('chain modes', () => {
  it('runs the four modes of experiments E2 and E9a, each against a recorded real-chain shape', () => {
    expect(
      CHAIN_MODES.map((m: { id: string; node: string; mode: string }) => [m.id, m.node, m.mode]),
    ).toEqual([
      ['hardhat-op', 'hardhat', 'op'],
      ['anvil-optimism', 'anvil', 'optimism'],
      ['anvil-tempo', 'anvil', 'tempo'],
      ['anvil-celo', 'anvil', 'celo'],
    ]);
    expect(modesOf('anvil').map((m: { id: string }) => m.id)).toEqual([
      'anvil-optimism',
      'anvil-tempo',
      'anvil-celo',
    ]);
    expect(modesOf('reth')).toEqual([]);
    for (const m of CHAIN_MODES) {
      expect(m.reference.source).toMatch(/^E(2|9a): /);
      // Only shapes of the real chains: no RPC URL, no hash and no address of them.
      expect(JSON.stringify(m.reference)).not.toMatch(/https?:|0x[0-9a-f]{40}/i);
    }
    expect(CHAIN_MODES.find((m: { id: string }) => m.id === 'anvil-celo')?.start.args).toEqual([
      '--celo',
      '--chain-id',
      '42220',
    ]);
  });
});

describe('faucet funding', () => {
  const rpcWith = (receipt: object) => ({
    call: async (method: string) =>
      method === 'eth_accounts' ? { result: ['0x1'] } : { result: `0x${'a'.repeat(64)}` },
    receipt: async () => receipt,
  });

  it('names why a funding transaction did not succeed', async () => {
    await expect(
      fundFromFaucet(rpcWith({ error: { code: 'timeout', message: 'no receipt' } }), ['0x2'], 1n),
    ).rejects.toThrow('a funding transaction did not succeed: no receipt');
    await expect(
      fundFromFaucet(rpcWith({ result: { status: '0x0' } }), ['0x2'], 1n),
    ).rejects.toThrow('a funding transaction did not succeed: status 0x0');
  });
});
