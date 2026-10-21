// Smoke test of the published packages: packs @hashspan/core, viem, cdp, x402, mpp and faults (`pnpm pack`), installs
// the tarballs and their peer dependencies into an empty project, and loads each with `require()` and `import` under
// the Node.js that runs the checks, or under Bun or Deno; @hashspan/faults supports Node.js only, so Bun and Deno skip
// it. No chain and no network beyond the npm registry install.
//
//   node scripts/smoke-packages.mjs                 pack, install and check with the current Node.js
//   node scripts/smoke-packages.mjs --matrix        print the Node.js versions CI checks, as JSON
//   node scripts/smoke-packages.mjs --prepare-only --dir <dir>   pack and install into <dir>, check nothing
//   node scripts/smoke-packages.mjs --check-only --dir <dir>     check a prepared <dir> (CI prepares it with the
//                                                               Node.js of .nvmrc and checks with an older one)
//   node scripts/smoke-packages.mjs --check-only --dir <dir> --runtime bun|deno   the same checks under Bun or Deno
//                                                               (`bun` or `deno` on PATH)
//
// Build first (`pnpm build`): the tarballs hold each package's dist.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const packageNames = ['core', 'viem', 'cdp', 'x402', 'mpp', 'faults'];
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

const mppAdapter = await load_('@hashspan/mpp');
// mppx is an ES module only: import() in both modes, as a CommonJS user of this package would.
const { Mppx, tempo } = await import('mppx/client');
{
  const mppx = Mppx.create({
    methods: [tempo()],
    polyfill: false,
    fetch: () => Promise.reject(new Error('no request in the smoke test')),
  });
  const traced = mppAdapter.withHashspan(mppx, options);
  assert.equal(typeof traced.flush, 'function');
  assert.equal(await traced.flush(), true);
}
{
  // The events of one settled payment, as mppx emits them, on a stand-in client: no network, no chain.
  exporter.reset();
  const handlers = {};
  const traced = mppAdapter.withHashspan({ on: (name, handler) => { handlers[name] = handler; } }, options);
  const challenge = {
    id: 'smoke-challenge',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'charge',
    request: { amount: '10000', currency: TO, recipient: TO, methodDetails: { chainId: 4217 } },
  };
  const hash = '0x' + 'ef'.repeat(32);
  const base64url = (json) => Buffer.from(JSON.stringify(json)).toString('base64url');
  const credential = 'Payment ' + base64url({
    challenge,
    payload: { type: 'hash', hash },
    source: 'did:pkh:eip155:4217:' + FROM,
  });
  const receipt = base64url({ method: 'tempo', reference: hash, status: 'success', timestamp: '2026-10-18T00:00:00Z' });
  handlers['challenge.received']({ challenge, input: 'https://api.example.com/weather' });
  handlers['credential.created']({ challenge, credential });
  handlers['payment.response']({
    challenge,
    credential,
    response: new Response('{}', { headers: { 'payment-receipt': receipt } }),
  });
  assert.equal(await traced.flush(), true);
  const span = exporter.getFinishedSpans().find((s) => s.name === 'payment 4217');
  assert.ok(span, 'mpp recorded a payment span');
  assert.equal(span.attributes['blockchain.payment.status'], 'settled');
  assertHashed(span, core.ATTR_BLOCKCHAIN_PAYMENT_PAYER, FROM);
}

// The fault proxy in front of a local stand-in for the node: one request passed on, one JSON-RPC error injected.
if (typeof Bun === 'undefined' && typeof Deno === 'undefined') {
  const faults = await load_('@hashspan/faults');
  const { createServer } = await load('node:http');
  let nodeRequests = 0;
  const node = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      nodeRequests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x1' }));
    });
  });
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  const proxy = await faults.startFaultProxy('http://127.0.0.1:' + node.address().port);
  try {
    const rpc = async (id) => {
      const response = await fetch(proxy.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_blockNumber', params: [] }),
      });
      return response.json();
    };
    assert.deepEqual(await rpc(1), { jsonrpc: '2.0', id: 1, result: '0x1' });
    proxy.set({ eth_blockNumber: { kind: 'rpc-error', code: -32005 } });
    assert.deepEqual(await rpc(2), {
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32005, message: 'injected fault' },
    });
    assert.equal(proxy.requests('eth_blockNumber'), 1);
    assert.equal(nodeRequests, 1, 'the injected fault never reached the node');
    await assert.rejects(faults.startFaultProxy('http://example.com'), /not loopback/);
  } finally {
    await proxy.stop();
    await new Promise((resolve) => node.close(resolve));
  }
} else {
  console.error('skipped @hashspan/faults: it supports Node.js only');
}

const runtime =
  typeof Bun !== 'undefined' ? 'Bun ' + Bun.version
  : typeof Deno !== 'undefined' ? 'Deno ' + Deno.version.deno
  : 'Node.js ' + process.version;
console.log(JSON.stringify({ runtime, keys }));
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

/** `minimumReleaseAge` of pnpm-workspace.yaml (in minutes), in milliseconds. */
function minimumReleaseAgeMs() {
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const minutes = Number(workspace.match(/^minimumReleaseAge: (\d+)$/m)?.[1]);
  if (!(minutes > 0)) throw new Error('pnpm-workspace.yaml sets no minimumReleaseAge');
  return minutes * 60_000;
}

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
      // The newest versions in each range, as a user would get them, but only those published before the minimum
      // release age of pnpm-workspace.yaml: npm does not read pnpm's setting. The packages come from the tarballs.
      `--before=${new Date(Date.now() - minimumReleaseAgeMs()).toISOString()}`,
      ...packed,
      ...[...peers].map(([name, range]) => `${name}@${range}`),
    ],
    { cwd: dir, stdio: 'inherit' },
  );
}

/** How each runtime runs a check file. */
const runtimes = {
  node: (file) => [process.execPath, [file]],
  bun: (file) => ['bun', [file]],
  // Deno resolves the packages from the project's node_modules, as Node.js does.
  deno: (file) => ['deno', ['run', '--allow-all', '--node-modules-dir=manual', file]],
};

function check(dir, runtime) {
  const results = {};
  for (const [file, source] of Object.entries(checkFiles)) writeFileSync(join(dir, file), source);
  for (const file of Object.keys(checkFiles)) {
    const [command, commandArgs] = runtimes[runtime](file);
    const run = spawnSync(command, commandArgs, { cwd: dir, encoding: 'utf8' });
    process.stderr.write(run.stderr ?? '');
    if (run.status !== 0)
      throw new Error(`${file} failed on ${runtime} (${run.error ?? `exit ${run.status}`})`);
    results[file] = JSON.parse(run.stdout.trim().split('\n').at(-1));
  }
  const [cjs, esm] = [results['check.cjs'], results['check.mjs']];
  if (JSON.stringify(cjs.keys) !== JSON.stringify(esm.keys)) {
    throw new Error(
      `require() and import export different names:\n${JSON.stringify(cjs.keys)}\n${JSON.stringify(esm.keys)}`,
    );
  }
  console.log(
    `ok: require() and import of ${Object.keys(esm.keys).length} packages on ${esm.runtime}`,
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
  const runtime = args.includes('--runtime') ? args[args.indexOf('--runtime') + 1] : 'node';
  if (!Object.hasOwn(runtimes, runtime)) throw new Error(`unknown runtime ${runtime}`);
  if (!args.includes('--prepare-only')) check(dir, runtime);
}
