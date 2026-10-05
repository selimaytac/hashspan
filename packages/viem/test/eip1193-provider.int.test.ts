// A wallet service's EIP-1193 provider (as Circle's developer-controlled wallets and Fireblocks offer) used through
// viem's custom() transport with an address-only account: viem sends eth_sendTransaction to the provider, which
// creates the transaction with the service, waits until it is sent, and answers with the hash. The provider here
// stands in for the service on Anvil: it delays eth_sendTransaction and answers no reads, as a provider without a
// fallback does, so receipts come through a public client of its own (docs/integrations.md, "Wallet services").
import { SpanStatusCode } from '@opentelemetry/api';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  MethodNotFoundRpcError,
} from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
/** How long the service takes to send a transaction: its queue and policy checks. */
const SERVICE_DELAY_MS = 150;

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** The service's provider: sends after a delay through Anvil, answers the chain id, and refuses every other method. */
function serviceProvider(options: { reject?: string } = {}) {
  const node = http(RPC_URL)({ chain: anvil });
  const methods: string[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      methods.push(method);
      if (method === 'eth_chainId') return node.request({ method } as never);
      if (method === 'eth_sendTransaction') {
        await new Promise((resolve) => setTimeout(resolve, SERVICE_DELAY_MS));
        if (options.reject) throw new Error(options.reject);
        return node.request({ method, params } as never);
      }
      throw new MethodNotFoundRpcError(new Error(`${method} is not supported`));
    },
  };
  return { provider, methods };
}

const toMs = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);

describe('a wallet service EIP-1193 provider through custom()', () => {
  it("records a send span over the service's call and a linked confirm span from a public client", async () => {
    const hashspan = withHashspan();
    const { provider, methods } = serviceProvider();
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: custom(provider),
    }).extend(hashspan);
    const reader = createPublicClient({ chain: anvil, transport: http(RPC_URL) }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1_000n });
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();

    expect(methods).toContain('eth_sendTransaction');
    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.from': account.toLowerCase(),
      'blockchain.tx.to': RECIPIENT,
    });
    // The send span covers the service's queue.
    expect(toMs(send.endTime) - toMs(send.startTime)).toBeGreaterThanOrEqual(SERVICE_DELAY_MS - 5);
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  });

  it('confirms through watch() on a public client when the provider answers no reads', async () => {
    const hashspan = withHashspan();
    const { provider } = serviceProvider();
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: custom(provider),
    }).extend(hashspan);
    const reader = createPublicClient({ chain: anvil, transport: http(RPC_URL) });

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    hashspan.watch(reader, { hash });
    await hashspan.flush();

    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  });

  it('records a send the service refuses and rethrows its error', async () => {
    const hashspan = withHashspan();
    const { provider } = serviceProvider({ reject: 'policy denied' });
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: custom(provider),
    }).extend(hashspan);

    await expect(wallet.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(
      'policy denied',
    );
    await hashspan.flush();

    const send = tracing.spanNamed('send 31337');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().filter((span) => span.name.startsWith('confirm '))).toHaveLength(0);
  });
});
