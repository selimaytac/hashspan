// The Hardhat 3 setups of docs/integrations.md, run as written in the Hardhat project of test/hardhat/ on Hardhat's
// in-process network (EDR, chain 31337, automine): a script with `hardhat run` (readme/hardhat-script.ts), a
// node:test file with `hardhat test nodejs` (readme/hardhat-test.ts) and an Ignition deployment from a script
// (readme/hardhat-ignition.ts). Each runs as a child process with the main Hardhat CLI, as a user runs it, and
// exports over OTLP to a receiver in this test. Every run passes `--no-compile`: the project's artifacts are
// committed, since a build downloads solc. No Anvil is needed. A control script without the `client` option shows that
// hardhat-viem's own clients record nothing, so the spans of the other runs come from the extended clients.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type ReceivedSpan, startOtlpReceiver } from './otlp-receiver.js';

const CHAIN_ID = 31337;
// Hardhat's first default account, the sender of every run.
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const HASH = /^(0x[0-9a-f]{64}) success$/m;

const { endpoint, received, close } = await startOtlpReceiver();

afterAll(close);

beforeEach(() => {
  received.length = 0;
});

/** Runs the Hardhat CLI in test/hardhat/ and returns what it printed. */
async function hardhat(...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [new URL('../node_modules/hardhat/dist/src/cli.js', import.meta.url).pathname, ...args],
    {
      cwd: new URL('./hardhat/', import.meta.url).pathname,
      env: {
        ...process.env,
        // Hardhat loads TypeScript with tsx, which maps `@hashspan/*` to their sources through this tsconfig.json.
        TSX_TSCONFIG_PATH: new URL('../tsconfig.json', import.meta.url).pathname,
        HARDHAT_DISABLE_TELEMETRY: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
      },
      timeout: 50_000,
    },
  );
  return stdout;
}

/** The hash of the call the file printed. */
function printedHash(output: string): string {
  const hash = output.match(HASH)?.[1];
  expect(hash, output).toBeDefined();
  return hash as string;
}

const spansOf = (service: string, kind: 'send' | 'confirm') =>
  received.filter((span) => span.service === service && span.name === `${kind} ${CHAIN_ID}`);
const hashesOf = (spans: ReceivedSpan[]) =>
  spans.map((span) => span.attributes['blockchain.tx.hash']);

/** One send span for the `incBy` call, from Hardhat's first account. */
function expectIncBySend(send: ReceivedSpan | undefined, hash: string): void {
  expect(send?.attributes).toMatchObject({
    'blockchain.chain.id': CHAIN_ID,
    'blockchain.tx.hash': hash,
    'blockchain.tx.from': SENDER,
    'blockchain.contract.function.name': 'incBy',
  });
}

/** A successful confirm span, in the block automine put the transaction in. */
function expectConfirm(confirm: ReceivedSpan | undefined, hash: string, block: number): void {
  expect(confirm?.attributes).toMatchObject({
    'blockchain.chain.id': CHAIN_ID,
    'blockchain.tx.hash': hash,
    'blockchain.tx.status': 'success',
    'blockchain.block.number': block,
  });
}

describe('Hardhat 3 with hardhat-viem clients extended with withHashspan()', () => {
  it('records the calls of a script, and only a confirm span for the deployment', {
    timeout: 60_000,
  }, async () => {
    const hash = printedHash(await hardhat('run', '--no-compile', '../readme/hardhat-script.ts'));
    const sends = spansOf('counter-script', 'send');
    const confirms = spansOf('counter-script', 'confirm');
    // viem's deployContract is not traced (#36): its confirm span comes from hardhat-viem waiting on the extended
    // public client. Block 1 holds the deployment, block 2 the call.
    expect(hashesOf(sends)).toEqual([hash]);
    expectIncBySend(sends[0], hash);
    expect(confirms).toHaveLength(2);
    const deployment = confirms.find((span) => span.attributes['blockchain.tx.hash'] !== hash);
    expect(deployment?.attributes['blockchain.tx.status']).toBe('success');
    expect(deployment?.attributes['blockchain.block.number']).toBe(1);
    expectConfirm(
      confirms.find((span) => span.attributes['blockchain.tx.hash'] === hash),
      hash,
      2,
    );
  });

  it('records nothing through the clients hardhat-viem creates itself (control)', {
    timeout: 60_000,
  }, async () => {
    printedHash(await hardhat('run', '--no-compile', 'scripts/default-clients.ts'));
    const service = received.filter((span) => span.service === 'counter-default-clients');
    expect(service.map((span) => span.name)).toEqual(['deploy_counter']);
  });

  it('records the calls of a node:test file run by hardhat test nodejs', {
    timeout: 60_000,
  }, async () => {
    const output = await hardhat('test', 'nodejs', '--no-compile', '../readme/hardhat-test.ts');
    expect(output).toMatch(/1 passing/);
    const sends = spansOf('counter-tests', 'send');
    const confirms = spansOf('counter-tests', 'confirm');
    expect(sends).toHaveLength(1);
    const hash = String(sends[0]?.attributes['blockchain.tx.hash']);
    expectIncBySend(sends[0], hash);
    expect(confirms).toHaveLength(2);
    expectConfirm(
      confirms.find((span) => span.attributes['blockchain.tx.hash'] === hash),
      hash,
      2,
    );
  });

  it('records no span for an Ignition deployment, and the calls through a contract bound to the extended clients', {
    timeout: 60_000,
  }, async () => {
    const hash = printedHash(await hardhat('run', '--no-compile', '../readme/hardhat-ignition.ts'));
    // Ignition's deployment (block 1) and its `incBy` call (block 2) were mined but not recorded; the call through
    // the bound contract is in block 3.
    const service = received.filter((span) => span.service === 'counter-ignition');
    expect(service.map((span) => span.name).sort()).toEqual([
      `confirm ${CHAIN_ID}`,
      `send ${CHAIN_ID}`,
    ]);
    expectIncBySend(spansOf('counter-ignition', 'send')[0], hash);
    expectConfirm(spansOf('counter-ignition', 'confirm')[0], hash, 3);
  });
});
