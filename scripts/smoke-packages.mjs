// Smoke test of the published packages: packs @hashspan/core, viem, cdp and x402 (`pnpm pack`), installs the tarballs
// and their peer dependencies into an empty project, and loads each with `require()` and `import` under the Node.js
// that runs the checks. No chain and no network beyond the npm registry install.
//
//   node scripts/smoke-packages.mjs                 pack, install and check with the current Node.js
//   node scripts/smoke-packages.mjs --matrix        print the Node.js versions CI checks, as JSON
//   node scripts/smoke-packages.mjs --prepare-only --dir <dir>   pack and install into <dir>, check nothing
//   node scripts/smoke-packages.mjs --check-only --dir <dir>     check a prepared <dir> (CI prepares it with the
//                                                               Node.js of .nvmrc and checks with an older one)
//
// Build first (`pnpm build`): the tarballs hold each package's dist.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const packageNames = ['core', 'viem', 'cdp', 'x402'];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const manifests = packageNames.map((name) =>
  readJson(join(root, 'packages', name, 'package.json')),
);

/** The lowest Node.js every package accepts, from `engines.node` (`>=22.3.0`). */
function lowestNode() {
  const minimums = new Set(
    manifests.map((manifest) => manifest.engines?.node?.match(/^>=(\d+\.\d+\.\d+)$/)?.[1]),
  );
  if (minimums.size !== 1 || minimums.has(undefined)) {
    throw new Error(`packages must share one ">=x.y.z" engines.node, found ${[...minimums]}`);
  }
  return [...minimums][0];
}

// What each package promises at runtime, checked by `require()` and by `import`. Spans go to a tracer provider the
// check passes in, so the checks need nothing running.
const checkBody = String.raw`
const { generateKeyPairSync } = await load('node:crypto');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await load('@opentelemetry/sdk-trace-base');
const assert = await load('node:assert/strict');

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const options = { address: 'hashed', tracerProvider };
const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const keys = {};
const load_ = async (name) => {
  const mod = await load(name);
  keys[name] = Object.keys(mod).sort();
  return mod;
};

// An address must not reach a span as it is: hashed mode replaces it with a digest.
const assertHashed = (span, attribute, address) => {
  const value = span.attributes[attribute];
  assert.match(String(value), /^sha256:[0-9a-f]{32}$/, attribute + ' is hashed');
  assert.ok(!String(value).includes(address.slice(2)));
};

const core = await load_('@hashspan/core');
assert.equal(typeof core.createTxTracker, 'function');
assert.equal(typeof core.VERSION, 'string');
{
  const tracker = core.createTxTracker(options);
  const send = tracker.startSend({ chainId: 8453, from: FROM, to: TO, value: 1n });
  send.end({ hash: '0x' + 'ab'.repeat(32) });
  const span = exporter.getFinishedSpans().find((s) => s.name === 'send 8453');
  assert.ok(span, 'a send span was recorded');
  assertHashed(span, core.ATTR_BLOCKCHAIN_TX_FROM, FROM);
  assertHashed(span, core.ATTR_BLOCKCHAIN_TX_TO, TO);
}

const viemAdapter = await load_('@hashspan/viem');
const { createWalletClient, custom } = await load('viem');
const hashspan = viemAdapter.withHashspan(options);
assert.equal(typeof hashspan.flush, 'function');
{
  exporter.reset();
  const hash = '0x' + 'cd'.repeat(32);
  const client = createWalletClient({
    account: FROM,
    transport: custom({
      request: async ({ method }) => {
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_sendTransaction') return hash;
        throw new Error('unexpected request ' + method);
      },
    }),
  }).extend(hashspan);
  assert.equal(await client.sendTransaction({ chain: null, to: TO, value: 1n }), hash);
  assert.equal(await hashspan.flush(), true);
  const span = exporter.getFinishedSpans().find((s) => s.name === 'send 8453');
  assert.ok(span, 'viem recorded a send span');
  assertHashed(span, core.ATTR_BLOCKCHAIN_TX_FROM, FROM);
}

// Neither SDK may reach a network: no usage tracking, no error reports, and no call is made here.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';
const cdpAdapter = await load_('@hashspan/cdp');
// By import() in both modes: the SDK's CommonJS build require()s an ES module (jose), which Node.js before 22.12
// refuses, so requiring the SDK fails there whatever this package does.
const { CdpClient } = await import('@coinbase/cdp-sdk');
{
  const ed = generateKeyPairSync('ed25519');
  const seed = ed.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cdp = new CdpClient({
    apiKeyId: 'smoke-key',
    apiKeySecret: Buffer.concat([seed, pub]).toString('base64'),
    walletSecret: ec.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    basePath: 'http://127.0.0.1:1',
  });
  const traced = cdpAdapter.withHashspan(cdp, options);
  assert.equal(typeof traced.flush, 'function');
  assert.equal(await traced.flush(), true);
}

const x402Adapter = await load_('@hashspan/x402');
const { x402Client } = await load('@x402/core/client');
{
  const client = new x402Client();
  const traced = x402Adapter.withHashspan(client, options);
  assert.equal(typeof traced.flush, 'function');
  assert.equal(await traced.flush(), true);
}

console.log(JSON.stringify({ node: process.version, keys }));
`;

const checkFiles = {
  'check.cjs': `const { createRequire } = require('node:module');
const req = createRequire(__filename);
const load = async (name) => req(name);
(async () => {
${checkBody}
})().catch((error) => { console.error(error); process.exit(1); });
`,
  'check.mjs': `const load = (name) => import(name);
${checkBody}
`,
};

function prepare(dir) {
  const tarballs = join(dir, 'tarballs');
  mkdirSync(tarballs, { recursive: true });
  for (const name of packageNames) {
    execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: join(root, 'packages', name),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
  const packed = readdirSync(tarballs).map((file) => join(tarballs, file));
  if (packed.length !== packageNames.length)
    throw new Error(`expected ${packageNames.length} tarballs`);

  // Peer dependencies as the packages declare them, plus the SDK that records the spans.
  const peers = new Map();
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {}))
      peers.set(name, range);
  }
  const viemDev = readJson(join(root, 'packages/viem/package.json')).devDependencies;
  peers.set('@opentelemetry/sdk-trace-base', viemDev['@opentelemetry/sdk-trace-base']);

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'hashspan-smoke', private: true }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      ...packed,
      ...[...peers].map(([name, range]) => `${name}@${range}`),
    ],
    { cwd: dir, stdio: 'inherit' },
  );
}

function check(dir) {
  const results = {};
  for (const [file, source] of Object.entries(checkFiles)) writeFileSync(join(dir, file), source);
  for (const file of Object.keys(checkFiles)) {
    const run = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' });
    process.stderr.write(run.stderr);
    if (run.status !== 0) throw new Error(`${file} failed on Node.js ${process.version}`);
    results[file] = JSON.parse(run.stdout.trim().split('\n').at(-1));
  }
  const [cjs, esm] = [results['check.cjs'], results['check.mjs']];
  if (JSON.stringify(cjs.keys) !== JSON.stringify(esm.keys)) {
    throw new Error(
      `require() and import export different names:\n${JSON.stringify(cjs.keys)}\n${JSON.stringify(esm.keys)}`,
    );
  }
  console.log(
    `ok: require() and import of ${packageNames.length} packages on Node.js ${process.version}`,
  );
}

const args = process.argv.slice(2);
if (args.includes('--matrix')) {
  // The lowest supported version, the latest 22.x and the latest 24.x (the version of .nvmrc).
  console.log(JSON.stringify([lowestNode(), '22', '24']));
} else {
  const at = args.indexOf('--dir');
  const dir = at === -1 ? mkdtempSync(join(tmpdir(), 'hashspan-smoke-')) : resolve(args[at + 1]);
  if (!args.includes('--check-only')) prepare(dir);
  if (!args.includes('--prepare-only')) check(dir);
}
