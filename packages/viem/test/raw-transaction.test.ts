// sendRawTransaction and sendRawTransactionSync: a transaction signed elsewhere and broadcast through viem gets a send
// span from the signed transaction's own fields, without its sender (#33).
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sendTransaction } from 'viem/actions';
import { base, optimism } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, type MockOptions, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemHasAction } from './viem-version.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

// Anvil's first test account, from its public default mnemonic; the mock node never checks the signature.
const signer = mnemonicToAccount('test test test test test test test test test test test junk');
// Given in full, so that a local account signs without asking the node for a nonce, gas or fees.
const PREPARED = {
  gas: 21_000n,
  nonce: 7,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
} as const;

const signed = (fields: Record<string, unknown> = {}): Promise<Hex> =>
  signer.signTransaction({
    chainId: base.id,
    to: TO,
    value: 5n,
    data: '0xa9059cbb0000',
    ...PREPARED,
    ...fields,
  } as never);

function wallets(
  node: MockOptions = {},
  account: typeof FROM | typeof signer = FROM,
  options: Parameters<typeof withHashspan>[0] = {},
) {
  const hashspan = withHashspan(options);
  const traced = mockTransport({ retryCount: 0, ...node });
  const client = createWalletClient({ account, chain: base, transport: traced.transport });
  return { hashspan, client, traced: client.extend(hashspan), calls: traced.calls };
}

const sendSpans = () => tracing.spans().filter((span) => span.name.startsWith('send '));

describe('sendRawTransaction', () => {
  it('records a send span from the signed transaction under the active span, without its sender', async () => {
    const { hashspan, traced } = wallets();
    const serializedTransaction = await signed();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const hash = await context.with(trace.setSpan(context.active(), tool), () =>
      traced.sendRawTransaction({ serializedTransaction }),
    );
    tool.end();
    await hashspan.flush();

    expect(hash).toBe(HASH);
    const send = tracing.spanNamed('send 8453');
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '5',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(send.status.code).toBe(SpanStatusCode.UNSET);
    expect(tracing.spans()).toHaveLength(2);
  });

  it("takes the chain id from the signed transaction, not the client's", async () => {
    const { hashspan, traced } = wallets();

    await traced.sendRawTransaction({
      serializedTransaction: await signed({ chainId: optimism.id }),
    });
    await hashspan.flush();

    expect(sendSpans().map((span) => span.name)).toEqual([`send ${optimism.id}`]);
  });

  it("takes the client's chain id for a transaction without one", async () => {
    const { hashspan, traced } = wallets();
    // A legacy transaction signed without EIP-155 replay protection carries no chain id.
    const serializedTransaction = await signer.signTransaction({
      type: 'legacy',
      to: TO,
      gas: 21_000n,
      gasPrice: 1n,
      nonce: 0,
    });

    await traced.sendRawTransaction({ serializedTransaction });
    await hashspan.flush();

    expect(sendSpans().map((span) => span.name)).toEqual(['send 8453']);
  });

  it('records the chain id only for a transaction it cannot parse, and sends it unchanged', async () => {
    const { hashspan, traced, calls } = wallets();

    const hash = await traced.sendRawTransaction({ serializedTransaction: '0x02c0ffee' });
    await hashspan.flush();

    expect(hash).toBe(HASH);
    expect(calls).toContain('eth_sendRawTransaction');
    const send = tracing.spanNamed('send 8453');
    expect(send.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(send.attributes['blockchain.tx.to']).toBeUndefined();
  });

  it('does not parse a transaction longer than a node accepts', async () => {
    const { hashspan, traced } = wallets();
    const huge = await signed({ data: `0x${'00'.repeat(130 * 1024)}` });

    await traced.sendRawTransaction({ serializedTransaction: huge });
    await hashspan.flush();

    expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.to']).toBeUndefined();
  });

  it('records the authorizations of a signed type 4 transaction', async () => {
    const { hashspan, traced } = wallets();
    // A local account always signs authorizations; the type leaves the method optional.
    const signAuthorization = signer.signAuthorization as NonNullable<
      typeof signer.signAuthorization
    >;
    const authorization = await signAuthorization({
      contractAddress: TO,
      chainId: base.id,
      nonce: 1,
    });
    const serializedTransaction = await signer.signTransaction({
      type: 'eip7702',
      chainId: base.id,
      to: TO,
      authorizationList: [authorization],
      ...PREPARED,
    });

    await traced.sendRawTransaction({ serializedTransaction });
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    expect(send.attributes['blockchain.tx.authorization.count']).toBe(1);
    expect(send.attributes['blockchain.tx.authorization.chain_ids']).toEqual([base.id]);
  });

  it('records a failed send and rethrows the error unchanged', async () => {
    const node = { sendError: { code: -32000, message: 'nonce too low' } };
    const { hashspan, client, traced } = wallets(node);
    const serializedTransaction = await signed();

    const plain = await client.sendRawTransaction({ serializedTransaction }).catch((e) => e);
    const error = await traced.sendRawTransaction({ serializedTransaction }).catch((e) => e);
    await hashspan.flush();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe((plain as Error).message);
    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
  });

  it('confirms in the background like any other send', async () => {
    const { hashspan, traced } = wallets({}, FROM, { confirm: { mode: 'background' } });

    await traced.sendRawTransaction({ serializedTransaction: await signed() });
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
  });
});

describe('on a public client', () => {
  it('records the raw send of a relayer that broadcasts through a public client', async () => {
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport }).extend(
      hashspan,
    );

    const hash = await reader.sendRawTransaction({ serializedTransaction: await signed() });
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    expect(send.attributes['blockchain.tx.to']).toBe(TO);
    expect(tracing.spanNamed('confirm 8453').links[0]?.context.spanId).toBe(
      send.spanContext().spanId,
    );
  });
});

describe('one send span per transaction', () => {
  it('records one span when a local account sends through the extended client', async () => {
    const { hashspan, traced, calls } = wallets({}, signer);

    await traced.sendTransaction({ to: TO, value: 1n, ...PREPARED });
    await hashspan.flush();

    // viem signs and calls its own sendRawTransaction, not the traced one.
    expect(calls).toContain('eth_sendRawTransaction');
    expect(sendSpans()).toHaveLength(1);
    expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.from']).toBe(
      signer.address.toLowerCase(),
    );
  });

  it("records the raw send of viem's sendTransaction function called with an extended client", async () => {
    const { hashspan, traced } = wallets({}, signer);

    await sendTransaction(traced, { to: TO, value: 1n, ...PREPARED });
    await hashspan.flush();

    expect(sendSpans()).toHaveLength(1);
    expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.from']).toBeUndefined();
  });

  it("records nothing for viem's sendTransaction function with an address-only account", async () => {
    const { hashspan, traced } = wallets();

    await sendTransaction(traced, { to: TO, value: 1n });
    await hashspan.flush();

    expect(sendSpans()).toHaveLength(0);
  });
});

describe.skipIf(!viemHasAction('sendRawTransactionSync'))('sendRawTransactionSync', () => {
  it('records a send span and a confirm span and returns the receipt unchanged', async () => {
    const { hashspan, client, traced } = wallets();
    const serializedTransaction = await signed();

    const receipt = await traced.sendRawTransactionSync({ serializedTransaction });
    await hashspan.flush();

    expect(receipt).toEqual(await client.sendRawTransactionSync({ serializedTransaction }));
    const send = tracing.spanNamed('send 8453');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(send.attributes).toMatchObject({ 'blockchain.tx.hash': HASH, 'blockchain.tx.to': TO });
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
  });

  it('records a failed sync send and rethrows the error', async () => {
    const node = { sendError: { code: -32000, message: 'nonce too low' } };
    const { hashspan, traced } = wallets(node);

    await expect(
      traced.sendRawTransactionSync({ serializedTransaction: await signed() }),
    ).rejects.toThrow();
    await hashspan.flush();

    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().filter((span) => span.name.startsWith('confirm '))).toHaveLength(0);
  });
});
