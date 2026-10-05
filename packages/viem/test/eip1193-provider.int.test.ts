// A wallet service that hands out an EIP-1193 provider (docs/integrations.md#wallet-services): the provider sends when
// it receives eth_sendTransaction and returns the hash, and answers no reads. The stand-in below signs with a key of
// its own and sends to Anvil, after a delay that stands for the service's queue, as such a service does.
import { SpanStatusCode } from '@opentelemetry/api';
import {
  createPublicClient,
  createWalletClient,
  custom,
  type EIP1193RequestFn,
  type Hex,
  http,
  type TransactionRequest,
  toHex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

// Anvil's third account, held by the service; the test never signs with it.
const serviceKey = privateKeyToAccount(
  toHex(
    mnemonicToAccount('test test test test test test test test test test test junk', {
      addressIndex: 2,
    }).getHdKey().privateKey as Uint8Array,
  ),
);
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const QUEUE_MS = 50;

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

/** The provider a wallet service returns: it sends, and refuses every read but the chain id and its accounts. */
function serviceProvider(options: { deny?: boolean } = {}) {
  const methods: string[] = [];
  const signer = createWalletClient({
    account: serviceKey,
    chain: anvil,
    transport: http(RPC_URL),
  });
  const request = (async ({ method, params }: { method: string; params?: unknown }) => {
    methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return toHex(anvil.id);
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [serviceKey.address];
      case 'eth_sendTransaction': {
        await new Promise((resolve) => setTimeout(resolve, QUEUE_MS));
        if (options.deny) {
          throw Object.assign(new Error('Transaction denied by policy'), { code: 4001 });
        }
        const [transaction] = params as [TransactionRequest<Hex>];
        return signer.sendTransaction({
          to: transaction.to,
          value: transaction.value === undefined ? undefined : BigInt(transaction.value),
          data: transaction.data,
        });
      }
      default:
        throw Object.assign(new Error(`${method} is not supported`), { code: 4200 });
    }
  }) as EIP1193RequestFn;
  return { provider: { request }, methods };
}

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});
afterAll(async () => {
  await instance.stop();
});

describe('a wallet service with an EIP-1193 provider, through custom()', () => {
  it('traces the send through the provider and the confirmation through a reader on the RPC endpoint', async () => {
    const { provider, methods } = serviceProvider();
    const hashspan = withHashspan();
    const wallet = createWalletClient({
      account: serviceKey.address,
      chain: anvil,
      transport: custom(provider),
    }).extend(hashspan);
    const reader = createPublicClient({ chain: anvil, transport: http(RPC_URL) }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1_000n });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');

    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.from': serviceKey.address.toLowerCase(),
    });
    // The send span covers the service's queue.
    const sendMs = send.duration[0] * 1000 + send.duration[1] / 1e6;
    expect(sendMs).toBeGreaterThanOrEqual(QUEUE_MS - 5);
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
    // hashspan asks the provider for nothing it does not answer.
    expect(methods.filter((method) => method !== 'eth_chainId')).toEqual(['eth_sendTransaction']);
  });

  it('confirms through watch() on a public client when the provider answers no reads', async () => {
    const { provider } = serviceProvider();
    const hashspan = withHashspan();
    const wallet = createWalletClient({
      account: serviceKey.address,
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

  it('ends the send span with the error when the service refuses, and rethrows it unchanged', async () => {
    const { provider } = serviceProvider({ deny: true });
    const wallet = createWalletClient({
      account: serviceKey.address,
      chain: anvil,
      transport: custom(provider),
    }).extend(withHashspan());

    const error = await wallet.sendTransaction({ to: RECIPIENT, value: 1n }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain('denied by policy');

    const send = tracing.spanNamed('send 31337');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().map((span) => span.name)).toEqual(['send 31337']);
  });
});
