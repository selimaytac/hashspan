import { createTxTracker } from '@hashspan/core';
import { context, diag, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, parseAbi, publicActions } from 'viem';
import { base, mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('sendTransaction', () => {
  it('emits a send span under the active span and returns the hash', async () => {
    const { transport } = mockTransport();
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const hash = await context.with(trace.setSpan(context.active(), tool), () =>
      wallet.sendTransaction({ to: TO, value: 5n, data: '0xa9059cbb0000' }),
    );
    tool.end();

    expect(hash).toBe(HASH);
    const send = tracing.spanNamed('send 8453');
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.attributes).toMatchObject({
      'blockchain.chain.id': 8453,
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': FROM,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '5',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(send.attributes['blockchain.contract.function.name']).toBeUndefined();
  });

  it('records a failed send and rethrows the original error', async () => {
    const { transport } = mockTransport({
      sendError: { code: -32000, message: 'insufficient funds' },
    });
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );

    const error = await wallet.sendTransaction({ to: TO, value: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe((error as Error).name);
  });

  it('resolves the chain id once per client when the client has no chain', async () => {
    const { transport, calls } = mockTransport({ chainIdHex: '0x1' });
    const wallet = createWalletClient({ account: FROM, transport }).extend(withHashspan());
    await wallet.sendTransaction({ to: TO, chain: null });
    await wallet.sendTransaction({ to: TO, chain: null });
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 1', 'send 1']);
    expect(calls.filter((m) => m === 'eth_chainId')).toHaveLength(1);
  });
});

describe('writeContract', () => {
  it('records the function name and selector', async () => {
    const { transport } = mockTransport();
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );
    await wallet.writeContract({
      address: TO,
      abi: erc20,
      functionName: 'transfer',
      args: [FROM, 1n],
    });

    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spanNamed('send 8453').attributes).toMatchObject({
      'blockchain.tx.to': TO,
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
  });
});

describe('waitForTransactionReceipt', () => {
  it('links the confirm span across a separate public client and records OP-stack fees', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: { l1Fee: '0x1388' } }).transport,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: TO });
    const receipt = await reader.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe('success');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.links[0]?.context.spanId).toBe(
      tracing.spanNamed('send 8453').spanContext().spanId,
    );
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 123,
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.effective_gas_price': '1000000000',
      'blockchain.tx.l1_fee': '5000',
      'blockchain.tx.fee': '21000000005000',
    });
  });

  it('reads an unformatted hex l1Fee on chains without the OP-stack formatter', async () => {
    const reader = createPublicClient({
      chain: mainnet,
      transport: mockTransport({ chainIdHex: '0x1', receipt: { l1Fee: '0x1388' } }).transport,
    }).extend(withHashspan());
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spanNamed('confirm 1').attributes['blockchain.tx.l1_fee']).toBe('5000');
  });

  it('records reverted receipts as errors', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: { status: '0x0' } }).transport,
    }).extend(withHashspan());
    const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
    expect(receipt.status).toBe('reverted');
    // The confirm span ends after the revert reason was fetched.
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(1));
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['error.type']).toBe('reverted');
  });

  it('records timeouts and rethrows', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    }).extend(withHashspan());
    const error = await reader
      .waitForTransactionReceipt({ hash: HASH, timeout: 60 })
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe('WaitForTransactionReceiptTimeoutError');
    expect(tracing.spanNamed('confirm 8453').attributes).toMatchObject({
      'blockchain.tx.status': 'timeout',
      'error.type': 'timeout',
    });
  });
});

describe('robustness', () => {
  it('never breaks the call when the tracker throws', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const broken = createTxTracker();
    broken.startSend = () => {
      throw new Error('boom');
    };
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(withHashspan({ tracker: broken }));
    await expect(wallet.sendTransaction({ to: TO })).resolves.toBe(HASH);
  });

  it('only overrides actions the client has', () => {
    const extension = withHashspan()(
      createPublicClient({ chain: base, transport: mockTransport().transport }),
    );
    expect(Object.keys(extension)).toEqual(['waitForTransactionReceipt']);
  });

  it('is shadowed by publicActions applied afterwards, so it must be applied last', async () => {
    const make = () =>
      createWalletClient({ account: FROM, chain: base, transport: mockTransport().transport });

    await make()
      .extend(withHashspan())
      .extend(publicActions)
      .waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spans()).toHaveLength(0);

    await make()
      .extend(publicActions)
      .extend(withHashspan())
      .waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spans().map((s) => s.name)).toEqual(['confirm 8453']);
  });
});

describe('types', () => {
  it('preserves viem action signatures', () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(withHashspan());
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport }).extend(
      withHashspan(),
    );
    expectTypeOf(wallet.sendTransaction).returns.resolves.toEqualTypeOf<`0x${string}`>();
    expectTypeOf(wallet.writeContract).returns.resolves.toEqualTypeOf<`0x${string}`>();
    expectTypeOf(reader.waitForTransactionReceipt).returns.resolves.toHaveProperty('gasUsed');
    expectTypeOf(reader.getBlockNumber).returns.resolves.toEqualTypeOf<bigint>();
  });
});
