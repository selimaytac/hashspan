// The README quick start, run as an adopter copies it: `test/readme/quick-start.ts`, whose region README.md shows
// unchanged (docs.test.ts), imported as it is. Only the URLs are redirected: Tempo's public RPC URL to this file's
// Anvil in Tempo mode, and the paid API to an mppx server in this process that settles on it. The README's sentences
// about the result are what the assertions check.
import { tempo as tempoChain } from 'viem/chains';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CONFIRM_SPAN, PAYMENT_SPAN, paidApi, RECIPIENT, startTempoAnvil } from './tempo-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const anvil = await startTempoAnvil();
const README_RPC_URL = tempoChain.rpcUrls.default.http[0];
const blocked: string[] = [];
let tracing: TestTracing;

beforeAll(() => {
  tracing = setupTracing();
  const api = paidApi(anvil.chain);
  const offline = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(README_RPC_URL)) {
      return offline(new Request(request.url.replace(README_RPC_URL, anvil.rpcUrl), request));
    }
    if (new URL(request.url).hostname === 'api.example.com') return api(request);
    if (new URL(request.url).hostname === '127.0.0.1') return offline(input, init);
    blocked.push(request.url);
    return Promise.reject(new TypeError('blocked by the test: no public network'));
  });
  // Anvil's second test account, funded with pathUSD in Tempo mode.
  vi.stubEnv(
    'MPP_QUICK_START_KEY',
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await tracing.teardown();
  await anvil.instance.stop();
});

it('records the payment span, then the confirm span, with what was paid, as the README says', async () => {
  await import('./readme/quick-start.js');

  expect(blocked).toEqual([]);
  const payment = tracing.spanNamed(PAYMENT_SPAN);
  expect(payment.attributes).toMatchObject({
    'blockchain.payment.protocol': 'mpp',
    'blockchain.payment.status': 'settled',
    'blockchain.payment.verified': true,
    'blockchain.payment.recipient': RECIPIENT,
    'mpp.mode': 'pull',
    'mpp.resource': 'https://api.example.com',
  });
  const confirm = tracing.spanNamed(CONFIRM_SPAN);
  expect(confirm.attributes['blockchain.tx.hash']).toBe(payment.attributes['blockchain.tx.hash']);
  expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  expect(confirm.links.map((link) => link.context.spanId)).toEqual([payment.spanContext().spanId]);
});
