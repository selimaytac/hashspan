import { createTxTracker, type TxTracker } from '@hashspan/core';
import { context, diag, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createPublicClient, encodeErrorResult, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTransport, HASH as RECEIPT_HASH } from '../../viem/test/mock-transport.js';
import { withHashspan } from '../src/index.js';
import { HASH, PAYER, paymentRequired } from './fake-x402.js';
import { setupTracing, type TestTracing } from './tracing.js';

type Hook = (ctx: unknown) => unknown;

/** Stands in for an x402Client: it keeps the hooks registered on it, for the test to call. */
function capturingClient() {
  const hooks: Record<string, Hook> = {};
  const register = (name: string) =>
    function (this: unknown, hook: Hook) {
      hooks[name] = hook;
      return this;
    };
  const client = {
    onBeforePaymentCreation: register('before'),
    onAfterPaymentCreation: register('after'),
    onPaymentCreationFailure: register('failure'),
    onPaymentResponse: register('response'),
  };
  /** Runs one payment through the hooks, as the SDK would; returns its contexts. */
  const pay = (
    required = paymentRequired(),
    settleResponse: unknown = { success: true, transaction: HASH },
    signed: unknown = { authorization: { from: PAYER } },
  ) => {
    const selectedRequirements = required.accepts[0];
    const paymentPayload = { x402Version: 2, payload: signed };
    expect(hooks.before?.({ paymentRequired: required, selectedRequirements })).toBeUndefined();
    expect(
      hooks.after?.({ paymentRequired: required, selectedRequirements, paymentPayload }),
    ).toBeUndefined();
    const respond = () =>
      hooks.response?.({ paymentPayload, requirements: selectedRequirements, settleResponse });
    return { selectedRequirements, paymentPayload, respond };
  };
  return { client, hooks, pay };
}

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('payments that are not traced', () => {
  it('passes x402 v1 and non-EVM payments through, with one warning each', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const { client, pay } = capturingClient();
    withHashspan(client);
    const v1 = { ...paymentRequired(), x402Version: 1 };
    const solana = paymentRequired({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' });
    const url = paymentRequired({
      network: 'https://rpc.example.com/?key=secret' as `${string}:${string}`,
    });
    for (const required of [v1, v1, solana, solana, url]) pay(required).respond();
    expect(tracing.spans()).toEqual([]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'hashspan: not tracing x402 payments of version 1',
      'hashspan: not tracing x402 payments on the network "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"',
      'hashspan: not tracing x402 payments on an unknown network',
    ]);
  });

  it('ignores hook contexts it does not understand', () => {
    const { client, hooks } = capturingClient();
    withHashspan(client);
    const getter = {
      get selectedRequirements(): never {
        throw new Error('getter ran');
      },
    };
    for (const ctx of [undefined, null, 42, {}, getter, { selectedRequirements: 'x' }]) {
      for (const hook of Object.values(hooks)) expect(hook(ctx)).toBeUndefined();
    }
    expect(tracing.spans()).toEqual([]);
  });
});

describe('the payer', () => {
  it('is read from an EIP-3009 or a Permit2 authorization', () => {
    const { client, pay } = capturingClient();
    withHashspan(client);
    const permit2Payer = '0x4444444444444444444444444444444444444444';
    pay(paymentRequired(), { success: true }).respond();
    pay(
      paymentRequired(),
      { success: true },
      { permit2Authorization: { from: permit2Payer } },
    ).respond();
    pay(paymentRequired(), { success: true }, { signature: '0x' }).respond();
    expect(tracing.spans().map((s) => s.attributes['blockchain.payment.payer'])).toEqual([
      PAYER,
      permit2Payer,
      undefined,
    ]);
  });
});

describe('open payment spans', () => {
  it('end the oldest as timeout when too many are open', () => {
    const { client, pay } = capturingClient();
    withHashspan(client);
    const payments = Array.from({ length: 1001 }, () => pay());
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spans()[0]?.attributes['error.type']).toBe('timeout');
    payments[0]?.respond();
    payments[1]?.respond();
    expect(tracing.spans()).toHaveLength(2);
    expect(tracing.spans()[1]?.attributes['blockchain.payment.status']).toBe('settled');
  });
});

describe('confirmation through the reader', () => {
  /** A reader whose node reports the settling transaction as reverted with an `Error(string)` message. */
  const revertingReader = () => {
    const mock = mockTransport({
      chainIdHex: '0x14a34',
      receipt: { status: '0x0' },
      callRevertData: encodeErrorResult({
        abi: parseAbi(['error Error(string)']),
        errorName: 'Error',
        args: ['text chosen by the contract'],
      }),
    });
    return { mock, reader: createPublicClient({ chain: baseSepolia, transport: mock.transport }) };
  };

  it('does not replay a reverted settlement for its revert reason by default', async () => {
    // The server chooses the settling transaction, and with it the contract whose revert text would be recorded.
    const { mock, reader } = revertingReader();
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader });
    pay(paymentRequired(), { success: true, transaction: RECEIPT_HASH }).respond();
    expect(await hashspan.flush()).toBe(true);

    const confirm = tracing.spanNamed('confirm 84532');
    expect(confirm.attributes['blockchain.tx.status']).toBe('reverted');
    expect(confirm.attributes['blockchain.tx.revert.reason']).toBeUndefined();
    expect(mock.calls).not.toContain('eth_call');
  });

  it('replays a reverted settlement when decodeRevertReason is set', async () => {
    const { reader } = revertingReader();
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader, decodeRevertReason: true });
    pay(paymentRequired(), { success: true, transaction: RECEIPT_HASH }).respond();
    expect(await hashspan.flush()).toBe(true);
    expect(tracing.spanNamed('confirm 84532').attributes['blockchain.tx.revert.reason']).toBe(
      'text chosen by the contract',
    );
  });

  it('confirms through a reader without a chain only on the chain its node reports', async () => {
    // The paid server names the network; a reader without a chain could be polled for any of them.
    const reader = createPublicClient({
      transport: mockTransport({ chainIdHex: '0x14a34' }).transport,
    });
    const { client, pay } = capturingClient();
    const hashspan = withHashspan(client, { reader });
    pay(paymentRequired({ network: 'eip155:999999' }), {
      success: true,
      transaction: RECEIPT_HASH,
    }).respond();
    pay(paymentRequired(), { success: true, transaction: RECEIPT_HASH }).respond();
    expect(await hashspan.flush()).toBe(true);
    expect(
      tracing
        .spans()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['confirm 84532', 'payment 84532', 'payment 999999']);
  });

  it('is asked for the chain of a settled or pending payment only', () => {
    const reader = vi.fn(() => undefined);
    const { client, pay } = capturingClient();
    withHashspan(client, { reader });
    pay().respond();
    pay(paymentRequired(), {
      success: false,
      errorReason: 'settlement_pending',
      transaction: HASH,
    }).respond();
    pay(paymentRequired(), {
      success: false,
      errorReason: 'invalid_signature',
      transaction: HASH,
    }).respond();
    pay(paymentRequired(), { success: true, transaction: 'not a hash' }).respond();
    expect(reader.mock.calls).toEqual([[84532], [84532]]);
  });

  it('is not asked when the settlement is on another network', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const reader = vi.fn(() => undefined);
    const { client, pay } = capturingClient();
    withHashspan(client, { reader });
    pay(paymentRequired(), { success: true, transaction: HASH, network: 'eip155:1' }).respond();
    expect(reader).not.toHaveBeenCalled();
    expect(tracing.spans()[0]?.attributes['blockchain.payment.status']).toBe('settled');
  });

  it('never breaks the payment when it throws or is on another chain', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    for (const reader of [
      () => {
        throw new Error('no client');
      },
      { chain: { id: 1 } } as never,
    ]) {
      const { client, pay } = capturingClient();
      withHashspan(client, { reader });
      expect(() => pay().respond()).not.toThrow();
    }
    expect(tracing.spans()).toHaveLength(2);
  });
});

describe('clients and trackers it cannot trace with', () => {
  it('registers nothing on a client without the payment hooks', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const httpClient = { onPaymentRequired: vi.fn() };
    const hashspan = withHashspan(httpClient);
    expect(httpClient.onPaymentRequired).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pass the x402Client'));
    expect(await hashspan.flush({ timeoutMs: 10 })).toBe(true);
  });

  it('registers nothing with a tracker from a core without startPayment', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const { startSend, startConfirm } = createTxTracker();
    const { client, hooks } = capturingClient();
    withHashspan(client, { tracker: { startSend, startConfirm } as unknown as TxTracker });
    expect(hooks).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no startPayment'));
  });

  it('traces a frozen client, without marking it', () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { client, pay } = capturingClient();
    withHashspan(Object.freeze(client));
    pay().respond();
    expect(tracing.spans()).toHaveLength(1);
  });
});

describe('a parent-based ratio sampler', () => {
  // The settlement's confirm span is recorded after the paid request returned and the tool span ended; with a
  // parent-based sampler it follows the payment span's decision (issue #333, docs/troubleshooting.md).
  it('samples the payment span and the confirm span of its settlement together', async () => {
    await tracing.teardown();
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.5) }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    try {
      const outcomes: { payment: boolean; confirm: boolean }[] = [];
      for (let run = 0; run < 60; run++) {
        exporter.reset();
        const reader = createPublicClient({
          chain: baseSepolia,
          transport: mockTransport({ chainIdHex: '0x14a34' }).transport,
          pollingInterval: 10,
        });
        const { client, pay } = capturingClient();
        const hashspan = withHashspan(client, { reader });
        const { respond } = trace.getTracer('agent').startActiveSpan('tool', (span) => {
          const payment = pay(paymentRequired(), { success: true, transaction: RECEIPT_HASH });
          span.end();
          return payment;
        });
        respond();
        await hashspan.flush();
        const names = exporter.getFinishedSpans().map((s) => s.name);
        outcomes.push({
          payment: names.some((name) => name.startsWith('payment ')),
          confirm: names.some((name) => name.startsWith('confirm ')),
        });
      }
      expect(outcomes.filter(({ payment, confirm }) => payment !== confirm)).toEqual([]);
      expect(outcomes.some(({ payment }) => payment)).toBe(true);
      expect(outcomes.some(({ payment }) => !payment)).toBe(true);
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
      tracing = setupTracing();
    }
  });
});
