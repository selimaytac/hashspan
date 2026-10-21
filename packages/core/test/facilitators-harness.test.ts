// Tests the Docker side of the facilitator conformance matrix (scripts/facilitators/) without running Docker: the
// targets and their recorded facts, the docker run arguments of every container, the Dockerfiles, the faults-proxy
// runner's scenario and the fault scenarios of the fault pass.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, NETWORK } from '../../../scripts/facilitators/corpus.mjs';
import { FAULT_CASES, faultScenarios } from '../../../scripts/facilitators/faults.mjs';
import { parseScenario } from '../../../scripts/facilitators/faults-runner/scenario.mjs';
import {
  ANVIL,
  anvilArgs,
  containerOf,
  DOCKER_NETWORK,
  FACILITATOR_PORT,
  facilitatorArgs,
  imageOf,
  MEMORY,
  PREFIX,
  proxyArgs,
  secretEnv,
  targets,
  wave,
  X402_COMMIT,
} from '../../../scripts/facilitators/targets.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, 'scripts/facilitators');
const read = (path: string) => readFileSync(join(dir, path), 'utf8');

/** Values of one flag in a docker argument list. */
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

const PROXY_URL = 'http://127.0.0.1:41234';
const runnable = wave(1);

/** Every docker run of one target's run: Anvil, the proxy and the facilitator. */
const allArgs = (name: string) => [
  { role: 'anvil', args: anvilArgs() },
  { role: 'proxy', args: proxyArgs({}, imageOf('faults', 'abc1234567890')) },
  { role: 'facilitator', args: facilitatorArgs(name, targets[name], PROXY_URL) },
];

describe('facilitator matrix targets', () => {
  it('runs the three x402 facilitators of one pinned commit first, and lists wave 2 as not yet run', () => {
    expect(X402_COMMIT).toBe('faa1c694c66a3732aaabbce93bdae140e521a67d');
    expect(Object.keys(targets)).toEqual(['typescript', 'go', 'python', 'x402-rs', 'qntx']);
    expect(runnable.map(([name]) => name)).toEqual(['typescript', 'go', 'python']);
    for (const [, def] of runnable) {
      expect(def.commit).toBe(X402_COMMIT);
      expect(def.repo).toBe('https://github.com/x402-foundation/x402');
      expect(def.path).toMatch(/^e2e\/facilitators\/(typescript|go|python)$/);
    }
    for (const name of ['x402-rs', 'qntx']) {
      expect(targets[name].wave).toBe(2);
      expect(targets[name].notYetRun).toBe(true);
      expect(() => facilitatorArgs(name, targets[name], PROXY_URL)).toThrow('not yet run');
    }
    // The two Rust facilitators have the fault class of the fault pass filed upstream already.
    expect(targets['x402-rs'].known).toEqual(['x402-rs#136']);
    expect(targets.qntx.known).toEqual(['qntx#73']);
  });

  it.each(runnable)(
    '%s records where its RPC URL comes from, with the fallback the source shows',
    (_name, def) => {
      expect(def.rpc.env).toBe('EVM_RPC_URL');
      // Each falls back to a public Base Sepolia RPC when the variable is unset, so the harness always sets it.
      expect(def.rpc.fallback).toMatch(/Base Sepolia/);
      expect(def.rpc.source.startsWith(`${def.path}/`)).toBe(true);
      expect(def.rpc.source.slice(def.path.length + 1)).toMatch(
        /^(index\.ts|main\.go|main\.py):\d+/,
      );
      expect(def.rpc.checkedAt).toBe(X402_COMMIT);
      expect(def.chainId.source).toMatch(/^e2e\/facilitators\//);
      expect(def.start.verified).toBe(false);
    },
  );

  it.each(runnable)(
    '%s runs its containers removable, named e14-, with 2 GiB, and no host path',
    (name) => {
      expect(PREFIX).toBe('e14-');
      expect(MEMORY).toBe('2g');
      for (const { role, args } of allArgs(name)) {
        expect({ role, start: args.slice(0, 3) }).toEqual({
          role,
          start: ['run', '--detach', '--rm'],
        });
        expect(values(args, '--name')[0]).toMatch(/^e14-[a-z0-9-]+$/);
        expect(args).toContain(`--memory=${MEMORY}`);
        expect(args.some((a) => ['-v', '-p', '--volume', '--mount'].includes(a))).toBe(false);
        expect(args.some((a) => a.startsWith('--mount') || a.startsWith('--volume'))).toBe(false);
        const text = args.join(' ');
        expect(text).not.toContain(homedir());
        expect(text).not.toMatch(/\/Users\/|\/home\/|\/root\//);
      }
      expect(containerOf(name)).toBe(`e14-${name}`);
    },
  );

  it('gives Anvil the namespace: an e14- network, DNS to 127.0.0.1, ports on 127.0.0.1 only', () => {
    const args = anvilArgs();
    expect(DOCKER_NETWORK).toBe('e14-net');
    expect(values(args, '--name')).toEqual(['e14-anvil']);
    expect(values(args, '--network')).toEqual(['e14-net']);
    expect(values(args, '--dns')).toEqual(['127.0.0.1']);
    const ports = values(args, '--publish');
    expect(ports).toEqual([
      `127.0.0.1:${ANVIL.hostPort}:${ANVIL.port}`,
      `127.0.0.1:${FACILITATOR_PORT.host}:${FACILITATOR_PORT.container}`,
    ]);
    // Inside its namespace Anvil listens on every interface, or the published port could not reach it. It runs on the
    // host clock, by which the facilitators judge validity windows; only the committed corpus is signed for 2024.
    const command = args.slice(args.indexOf(ANVIL.image) + 1);
    expect(command).toEqual([
      '--host',
      '0.0.0.0',
      '--port',
      String(ANVIL.port),
      '--chain-id',
      '84532',
    ]);
    expect(args).not.toContain('--timestamp');
    expect(NETWORK).toBe('eip155:84532');
  });

  it.each(runnable)(
    '%s joins Anvil with --network container:, publishing nothing of its own',
    (name) => {
      for (const { role, args } of allArgs(name).filter((a) => a.role !== 'anvil')) {
        expect({ role, network: values(args, '--network') }).toEqual({
          role,
          network: ['container:e14-anvil'],
        });
        for (const flag of ['--publish', '--dns', '--hostname', '--entrypoint']) {
          expect({ role, flag, has: args.includes(flag) }).toEqual({ role, flag, has: false });
        }
      }
    },
  );

  it.each(runnable)(
    '%s takes its RPC from the proxy on 127.0.0.1 and its key by name only',
    (name, def) => {
      const args = facilitatorArgs(name, def, PROXY_URL);
      const env = values(args, '--env');
      expect(env).toContain(`EVM_RPC_URL=${PROXY_URL}`);
      expect(env).toContain(`EVM_NETWORK=${NETWORK}`);
      expect(env).toContain(`PORT=${FACILITATOR_PORT.container}`);
      expect(env).toContain('FACILITATOR_EVM_PRIVATE_KEY');
      expect(args.join(' ')).not.toContain(ACCOUNTS.facilitator.slice(2));
      expect(secretEnv()).toEqual({ FACILITATOR_EVM_PRIVATE_KEY: ACCOUNTS.facilitator });
      expect(() => facilitatorArgs(name, def, 'http://anvil:8545')).toThrow('127.0.0.1');
      expect(args).toContain(imageOf(name, X402_COMMIT));
    },
  );

  it('hands the proxy its scenario and a loopback upstream through env', () => {
    const scenario = { eth_sendRawTransaction: { fault: { kind: 'reset' }, times: 1 } };
    const args = proxyArgs(scenario, 'e14-faults:abc');
    const env = values(args, '--env');
    expect(env).toEqual([
      `FAULT_SCENARIO=${JSON.stringify(scenario)}`,
      `FAULT_UPSTREAM=http://127.0.0.1:${ANVIL.port}`,
    ]);
    expect(values(args, '--name')).toEqual(['e14-faults']);
  });
});

describe('facilitator matrix images', () => {
  const dockerfiles = readdirSync(join(dir, 'docker')).filter((f) => f.endsWith('.Dockerfile'));

  it('has one Dockerfile per wave-1 target and one for the proxy runner', () => {
    expect(dockerfiles.sort()).toEqual([
      'faults.Dockerfile',
      'go.Dockerfile',
      'python.Dockerfile',
      'typescript.Dockerfile',
    ]);
    for (const [name, def] of runnable) expect(def.dockerfile).toBe(`${name}.Dockerfile`);
  });

  it.each(dockerfiles)(
    '%s copies its build context only, with no mount and no download',
    (file) => {
      const lines = read(`docker/${file}`)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      for (const line of lines) {
        const instruction = line.split(/\s+/)[0] as string;
        expect(['FROM', 'WORKDIR', 'COPY', 'RUN', 'ENV', 'CMD', 'USER']).toContain(instruction);
        expect(line).not.toMatch(/--mount|^ADD\b|https?:\/\//);
      }
      expect(lines.some((l) => l.startsWith('COPY '))).toBe(true);
      // Keys come at run time, by env name; no image holds one.
      expect(lines.join('\n')).not.toMatch(/PRIVATE_KEY|0x[0-9a-f]{64}/i);
    },
  );

  it('runs the proxy runner from the built faults package, with remote upstreams left refused', () => {
    const dockerfile = read('docker/faults.Dockerfile');
    expect(dockerfile).toMatch(/COPY node_modules\/@hashspan\/faults /);
    const runner = read('faults-runner/runner.mjs');
    expect(runner).toContain("from '@hashspan/faults'");
    expect(runner).not.toContain('allowRemoteUpstream');
  });
});

describe('faults-proxy runner scenario', () => {
  it('takes the JSON rules of one scenario', () => {
    expect(parseScenario(undefined)).toEqual({});
    expect(parseScenario('{}')).toEqual({});
    const rules = {
      eth_sendRawTransaction: { fault: { kind: 'rpc-error', code: -32603 }, times: 1 },
      eth_getTransactionReceipt: [{ fault: { kind: 'hang' }, after: 1, times: 1 }],
    };
    expect(parseScenario(JSON.stringify(rules))).toEqual(rules);
    for (const kind of ['hang', 'reset', 'drop', 'truncate', 'previous']) {
      expect(parseScenario(JSON.stringify({ eth_call: { kind } }))).toEqual({ eth_call: { kind } });
    }
    expect(parseScenario('{"eth_call":{"kind":"http","status":429}}')).toEqual({
      eth_call: { kind: 'http', status: 429 },
    });
  });

  it('refuses what JSON cannot carry or the proxy does not know', () => {
    expect(() => parseScenario('not json')).toThrow('FAULT_SCENARIO');
    expect(() => parseScenario('[]')).toThrow('an object');
    expect(() => parseScenario('{"eth_call":{"kind":"result"}}')).toThrow('result');
    expect(() => parseScenario('{"eth_call":{"kind":"melt"}}')).toThrow('melt');
    expect(() => parseScenario('{"eth_call":{"fault":{"kind":"hang"},"times":-1}}')).toThrow(
      'times',
    );
    expect(() => parseScenario('{"eth_call":{"kind":"rpc-error"}}')).toThrow('code');
  });
});

describe('fault pass', () => {
  it('injects each kind once on the send and on the receipt, for the valid case of each scheme', () => {
    expect(FAULT_CASES).toEqual([
      'exact-eip3009-valid',
      'exact-permit2-valid',
      'upto-permit2-partial',
    ]);
    const scenarios = faultScenarios();
    expect(scenarios.map((s: { id: string }) => s.id)).toEqual([
      'eth_sendRawTransaction:hang',
      'eth_sendRawTransaction:reset',
      'eth_sendRawTransaction:drop',
      'eth_sendRawTransaction:truncate',
      'eth_sendRawTransaction:rpc-error',
      'eth_getTransactionReceipt:hang',
      'eth_getTransactionReceipt:reset',
      'eth_getTransactionReceipt:drop',
      'eth_getTransactionReceipt:truncate',
      'eth_getTransactionReceipt:rpc-error',
    ]);
    for (const s of scenarios) {
      const rules = parseScenario(JSON.stringify(s.rules));
      expect(Object.keys(rules)).toEqual([s.method]);
      expect(rules[s.method].times).toBe(1);
    }
    expect(JSON.stringify(scenarios)).not.toMatch(/\bbugs?\b/i);
  });
});
