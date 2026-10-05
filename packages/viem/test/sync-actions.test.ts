// sendTransactionSync and writeContractSync, which send a transaction and wait for its receipt in one call: one send
// span and one confirm span, as for sendTransaction followed by waitForTransactionReceipt (#370).
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { createWalletClient, encodeErrorResult, parseAbi } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, type MockOptions, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast, viemHasAction } from './viem-version.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const erc20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'error Blocked(string why)',
]);
// Anvil's first test account, from its public default mnemonic; the mock node never checks the signature.
const signer = mnemonicToAccount('test test test test test test test test test test test junk');
// Given in full, so that a local account signs without asking the node for a nonce, gas or fees.
const PREPARED = {
  gas: 21_000n,
  nonce: 0,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
} as const;

const toMs = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);
const sameTime = (a: ReadableSpan, b: ReadableSpan) => {
  expect(toMs(a.startTime)).toBe(toMs(b.startTime));
  expect(toMs(a.endTime)).toBe(toMs(b.endTime));
};

/** A wallet client on the mock node, untraced and extended with hashspan. */
function wallets(node: MockOptions = {}, account: typeof FROM | typeof signer = FROM) {
  const hashspan = withHashspan();
  const tracedNode = mockTransport({ retryCount: 0, ...node });
  const make = (transport = mockTransport({ retryCount: 0, ...node }).transport) =>
    createWalletClient({ account, chain: base, transport, pollingInterval: 10 });
  return {
    hashspan,
    plain: make(),
    traced: make(tracedNode.transport).extend(hashspan),
    calls: tracedNode.calls,
  };
}

// sendTransactionSync and writeContractSync came with viem 2.38.0.
describe.skipIf(!viemHasAction('sendTransactionSync'))('sendTransactionSync', () => {
  it('records a send span and a confirm span under the active span and returns the receipt unchanged', async () => {
    const { hashspan, plain, traced } = wallets();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const receipt = await context.with(trace.setSpan(context.active(), tool), () =>
      traced.sendTransactionSync({ to: TO, value: 5n, data: '0xa9059cbb0000' }),
    );
    tool.end();
    await hashspan.flush();

    expect(receipt).toEqual(
      await plain.sendTransactionSync({ to: TO, value: 5n, data: '0xa9059cbb0000' }),
    );
    const send = tracing.spanNamed('send 8453');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(confirm.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': FROM,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '5',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(send.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 123,
      'blockchain.tx.fee': (21_000n * 1_000_000_000n).toString(),
    });
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    // viem returns the hash only with the receipt: both spans cover the call.
    sameTime(send, confirm);
    expect(tracing.spans()).toHaveLength(3);
  });

  it('records a reverted receipt and returns it unchanged', async () => {
    const node = { receipt: { status: '0x0' } };
    const { hashspan, plain, traced } = wallets(node);

    const receipt = await traced.sendTransactionSync({ to: TO });
    await hashspan.flush();

    expect(receipt.status).toBe('reverted');
    expect(receipt).toEqual(await plain.sendTransactionSync({ to: TO }));
    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.UNSET);
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'error.type': 'reverted',
    });
  });

  // throwOnReceiptRevert came with viem 2.38.2.
  it.skipIf(!viemAtLeast('2.38.2'))(
    'records the receipt a throwOnReceiptRevert rejection carries and rethrows the error',
    async () => {
      const node = { receipt: { status: '0x0' } };
      const { hashspan, plain, traced } = wallets(node);

      const error = await traced
        .sendTransactionSync({ to: TO, throwOnReceiptRevert: true })
        .catch((e: unknown) => e);
      await hashspan.flush();

      const untraced = await plain
        .sendTransactionSync({ to: TO, throwOnReceiptRevert: true })
        .catch((e: unknown) => e);
      expect((error as Error).name).toBe((untraced as Error).name);
      expect((error as Error).message).toBe((untraced as Error).message);
      const send = tracing.spanNamed('send 8453');
      expect(send.status.code).toBe(SpanStatusCode.UNSET);
      expect(send.attributes['blockchain.tx.hash']).toBe(HASH);
      const confirm = tracing.spanNamed('confirm 8453');
      expect(confirm.attributes['blockchain.tx.status']).toBe('reverted');
      sameTime(send, confirm);
    },
  );

  it('records a failed send without a confirm span and rethrows the error', async () => {
    const node = { sendError: { code: -32000, message: 'insufficient funds' } };
    const { hashspan, plain, traced } = wallets(node);

    const error = await traced.sendTransactionSync({ to: TO }).catch((e: unknown) => e);
    await hashspan.flush();

    const untraced = await plain.sendTransactionSync({ to: TO }).catch((e: unknown) => e);
    expect((error as Error).name).toBe((untraced as Error).name);
    expect((error as Error).message).toBe((untraced as Error).message);
    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('records a timeout of the wait as a failed send', async () => {
    const { hashspan, traced } = wallets({ receipt: null });

    const error = await traced
      .sendTransactionSync({ to: TO, timeout: 50 })
      .catch((e: unknown) => e);
    await hashspan.flush();

    expect(error).toBeInstanceOf(Error);
    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('traces a local account, which sends with eth_sendRawTransactionSync', async () => {
    const { hashspan, plain, traced, calls } = wallets({}, signer);

    const receipt = await traced.sendTransactionSync({ to: TO, value: 1n, ...PREPARED });
    await hashspan.flush();

    expect(calls).toContain('eth_sendRawTransactionSync');
    expect(calls).not.toContain('eth_getTransactionReceipt');

    expect(receipt).toEqual(await plain.sendTransactionSync({ to: TO, value: 1n, ...PREPARED }));
    const send = tracing.spanNamed('send 8453');
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': signer.address.toLowerCase(),
      'blockchain.tx.nonce': 0,
    });
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBe('success');
  });

  it('records a failed eth_sendRawTransactionSync of a local account', async () => {
    const node = { sendError: { code: -32000, message: 'nonce too low' } };
    const { hashspan, traced } = wallets(node, signer);

    await expect(traced.sendTransactionSync({ to: TO, ...PREPARED })).rejects.toThrow();
    await hashspan.flush();

    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
  });

  it('starts no background confirmation: the receipt is already known', async () => {
    const { transport, calls } = mockTransport();
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport,
      pollingInterval: 10,
    }).extend(hashspan);

    await wallet.sendTransactionSync({ to: TO });
    await hashspan.flush();

    // viem's own wait reads the receipt once; telemetry reads nothing more.
    expect(calls.filter((method) => method === 'eth_getTransactionReceipt')).toHaveLength(1);
    expect(tracing.spans().filter((s) => s.name === 'confirm 8453')).toHaveLength(1);
  });

  it('records both spans over the call on a client without a chain, once the chain id is known', async () => {
    const { transport } = mockTransport();
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, transport, pollingInterval: 10 }).extend(
      hashspan,
    );
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const before = Date.now();
    await context.with(trace.setSpan(context.active(), tool), () =>
      wallet.sendTransactionSync({ to: TO, chain: null }),
    );
    const after = Date.now();
    tool.end();
    await hashspan.flush();

    const send = tracing.spanNamed('send 8453');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(confirm.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    sameTime(send, confirm);
    expect(toMs(send.startTime)).toBeGreaterThanOrEqual(before - 1);
    expect(toMs(send.endTime)).toBeLessThanOrEqual(after + 1);
  });
});

describe.skipIf(!viemHasAction('writeContractSync'))('writeContractSync', () => {
  const args = { address: TO, abi: erc20, functionName: 'transfer', args: [TO, 1n] } as const;

  it('records the function on the send span and the receipt on the confirm span', async () => {
    const { hashspan, plain, traced } = wallets();

    const receipt = await traced.writeContractSync(args);
    await hashspan.flush();

    expect(receipt).toEqual(await plain.writeContractSync(args));
    expect(tracing.spanNamed('send 8453').attributes).toMatchObject({
      'blockchain.tx.hash': HASH,
      'blockchain.tx.to': TO,
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBe('success');
  });

  it('decodes the revert reason of a reverted write with its ABI', async () => {
    const node = {
      receipt: { status: '0x0' },
      callRevertData: encodeErrorResult({ abi: erc20, errorName: 'Blocked', args: ['paused'] }),
    };
    const { hashspan, traced } = wallets(node);

    const receipt = await traced.writeContractSync(args);
    await hashspan.flush();

    expect(receipt.status).toBe('reverted');
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.revert.reason']).toBe(
      'Blocked(paused)',
    );
  });

  // throwOnReceiptRevert came with viem 2.38.2.
  it.skipIf(!viemAtLeast('2.38.2'))(
    'records the receipt a throwOnReceiptRevert rejection carries through the contract error',
    async () => {
      const { hashspan, traced } = wallets({ receipt: { status: '0x0' } });

      const error = await traced
        .writeContractSync({ ...args, throwOnReceiptRevert: true })
        .catch((e: unknown) => e);
      await hashspan.flush();

      expect((error as Error).name).toBe('ContractFunctionExecutionError');
      expect(tracing.spanNamed('send 8453').attributes['blockchain.tx.hash']).toBe(HASH);
      expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.status']).toBe('reverted');
    },
  );

  it('records a failed send and rethrows the error', async () => {
    const node = { sendError: { code: -32000, message: 'insufficient funds' } };
    const { hashspan, plain, traced } = wallets(node);

    const error = await traced.writeContractSync(args).catch((e: unknown) => e);
    await hashspan.flush();

    const untraced = await plain.writeContractSync(args).catch((e: unknown) => e);
    expect((error as Error).name).toBe((untraced as Error).name);
    expect((error as Error).message).toBe((untraced as Error).message);
    expect(tracing.spanNamed('send 8453').status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 8453']);
  });
});
