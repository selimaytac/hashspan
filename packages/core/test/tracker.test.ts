import { context, diag, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = '0x9f2c1e3a5b7d9f2c1e3a5b7d9f2c1e3a5b7d9f2c1e3a5b7d9f2c1e3a5b7d9f2c';
const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

const receipt = {
  status: 'success' as const,
  blockNumber: 123n,
  gasUsed: 21_000n,
  effectiveGasPrice: 1_000_000_000n,
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('send span', () => {
  it('is a CLIENT child of the active span with transaction attributes', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool transfer');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker
        .startSend({
          chainId: CHAIN_ID,
          from: FROM,
          to: TO,
          value: 10n ** 18n,
          nonce: 7,
          functionName: 'transfer',
          functionSelector: '0xa9059cbb',
        })
        .end(HASH);
    });
    tool.end();

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.kind).toBe(SpanKind.CLIENT);
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.instrumentationScope.name).toBe('@hashspan/core');
    expect(send.attributes).toMatchObject({
      'blockchain.system': 'evm',
      'blockchain.chain.id': CHAIN_ID,
      'blockchain.operation.name': 'send',
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': FROM,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '1000000000000000000',
      'blockchain.tx.nonce': 7,
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(send.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records failures with error status and error.type', () => {
    const tracker = createTxTracker();
    class InsufficientFundsError extends Error {
      override name = 'InsufficientFundsError';
    }
    tracker.startSend({ chainId: CHAIN_ID }).fail(new InsufficientFundsError('not enough ETH'));

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe('InsufficientFundsError');
    expect(send.events.map((e) => e.name)).toContain('exception');
  });

  it('ignores repeated end/fail calls', () => {
    const tracker = createTxTracker();
    const handle = tracker.startSend({ chainId: CHAIN_ID });
    handle.end(HASH);
    handle.fail(new Error('late'));
    handle.end(HASH);
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe('confirm span', () => {
  it('links to the send span and records receipt data and fees', () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).end(HASH);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end({ ...receipt, l1Fee: 5_000n });

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.kind).toBe(SpanKind.CLIENT);
    expect(confirm.links).toHaveLength(1);
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.operation.name': 'confirm',
      'blockchain.tx.hash': HASH,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 123,
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.effective_gas_price': '1000000000',
      'blockchain.tx.l1_fee': '5000',
      'blockchain.tx.fee': '21000000005000',
    });
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('is a child of the active span when something waits for the receipt', () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).end(HASH);
    const waiter = trace.getTracer('test').startSpan('wait');
    context.with(trace.setSpan(context.active(), waiter), () => {
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    });
    waiter.end();

    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.parentSpanContext?.spanId).toBe(waiter.spanContext().spanId);
  });

  it("falls back to the send span's parent when confirmed in the background", () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool transfer');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker.startSend({ chainId: CHAIN_ID }).end(HASH);
    });
    tool.end();

    // No active span here, e.g. a background receipt watcher.
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);

    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  });

  it('works without a known send span', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.links).toHaveLength(0);
    expect(confirm.parentSpanContext).toBeUndefined();
  });

  it('marks reverted transactions as errors with the revert reason', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end({
      ...receipt,
      status: 'reverted',
      revertReason: 'ERC20: transfer amount exceeds balance',
    });

    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'blockchain.tx.revert.reason': 'ERC20: transfer amount exceeds balance',
      'error.type': 'reverted',
    });
  });

  it('marks timeouts as errors', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).timeout();
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'timeout',
      'error.type': 'timeout',
    });
  });

  it('omits the fee when the gas price is unknown', () => {
    const tracker = createTxTracker();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ status: 'success', blockNumber: 1n, gasUsed: 21_000n });
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.attributes['blockchain.tx.fee']).toBeUndefined();
  });
});

describe('agent identity', () => {
  it('copies agent identity from baggage onto both spans', () => {
    const tracker = createTxTracker({ agent: { name: 'treasury-bot' } });
    const ctx = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ 'gen_ai.agent.id': { value: 'agent-42' } }),
    );
    context.with(ctx, () => {
      tracker.startSend({ chainId: CHAIN_ID }).end(HASH);
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    });

    for (const span of tracing.spans()) {
      expect(span.attributes).toMatchObject({
        'gen_ai.agent.id': 'agent-42',
        'gen_ai.agent.name': 'treasury-bot',
      });
    }
  });
});

describe('privacy', () => {
  it('drops addresses in off mode', () => {
    createTxTracker({ address: 'off' })
      .startSend({ chainId: CHAIN_ID, from: FROM, to: TO })
      .end(HASH);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(send.attributes['blockchain.tx.to']).toBeUndefined();
  });

  it('hashes addresses in hashed mode', () => {
    createTxTracker({ address: 'hashed' }).startSend({ chainId: CHAIN_ID, from: FROM }).end(HASH);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.from']).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('lets the redaction hook rewrite or drop attributes', () => {
    const tracker = createTxTracker({
      redact: (attributes) => {
        const { 'blockchain.tx.value': _value, ...rest } = attributes;
        return { ...rest, 'blockchain.contract.function.name': 'redacted' };
      },
    });
    tracker.startSend({ chainId: CHAIN_ID, value: 5n, functionName: 'transfer' }).end(HASH);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.value']).toBeUndefined();
    expect(send.attributes['blockchain.contract.function.name']).toBe('redacted');
  });

  it('fails closed when the redaction hook throws', () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker({
      redact: () => {
        throw new Error('boom');
      },
    });
    tracker.startSend({ chainId: CHAIN_ID, from: FROM, to: TO, value: 5n }).end(HASH);

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(send.attributes['blockchain.tx.to']).toBeUndefined();
    expect(send.attributes['blockchain.tx.value']).toBeUndefined();
    expect(send.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(diagError).toHaveBeenCalled();
  });
});

describe('explicit parent context', () => {
  it('parents send and confirm spans on the given context', () => {
    const tracker = createTxTracker();
    const explicit = trace.getTracer('test').startSpan('explicit');
    const active = trace.getTracer('test').startSpan('active');
    const explicitCtx = trace.setSpan(context.active(), explicit);
    context.with(trace.setSpan(context.active(), active), () => {
      tracker.startSend({ chainId: CHAIN_ID }, explicitCtx).end(HASH);
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }, explicitCtx).end(receipt);
    });
    explicit.end();
    active.end();

    const explicitId = explicit.spanContext().spanId;
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).parentSpanContext?.spanId).toBe(explicitId);
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).parentSpanContext?.spanId).toBe(explicitId);
  });
});

describe('confirm failures', () => {
  it('records receipt retrieval errors', () => {
    const tracker = createTxTracker();
    class TransactionNotFoundError extends Error {
      override name = 'TransactionNotFoundError';
    }
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .fail(new TransactionNotFoundError('gone'));
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['error.type']).toBe('TransactionNotFoundError');
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
  });
});

describe('never breaks the caller', () => {
  it('still ends the send span and stores the link when the redaction hook returns garbage', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker({ redact: () => undefined as never });
    tracker.startSend({ chainId: CHAIN_ID, from: FROM }).end(HASH);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).links).toHaveLength(1);
  });

  it('treats an unknown address mode as off instead of dropping spans', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    createTxTracker({ address: 'bogus' as never })
      .startSend({ chainId: CHAIN_ID, from: FROM })
      .end(HASH);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(send.attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it('swallows errors from a broken tracer provider', () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker({
      tracerProvider: {
        getTracer: () => {
          throw new Error('broken provider');
        },
      },
    });
    expect(() => {
      tracker.startSend({ chainId: CHAIN_ID }).end(HASH);
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    }).not.toThrow();
    expect(diagError).toHaveBeenCalled();
  });

  it('swallows malformed receipts', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker();
    const garbage = { status: 'success', blockNumber: 'nope', gasUsed: {} } as never;
    expect(() =>
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(garbage),
    ).not.toThrow();
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`)).toBeDefined();
  });
});

describe('error privacy', () => {
  const CALLDATA = `0xa9059cbb${'0'.repeat(24)}${TO.slice(2)}${'0'.repeat(63)}1`;

  /** Shaped like a viem error: a short first line, then request arguments with addresses and calldata. */
  function sendError(): Error {
    const error = new Error(
      [
        `insufficient funds for gas * price + value: address ${FROM} have 0 want 1`,
        '',
        'Request Arguments:',
        `  from:  ${FROM}`,
        `  to:    ${TO}`,
        `  data:  ${CALLDATA}`,
      ].join('\n'),
    );
    error.name = 'TransactionExecutionError';
    return error;
  }

  /** Everything the exporter would see for a span, as one string. */
  const exported = (name: string): string => {
    const span = tracing.spanNamed(name);
    return JSON.stringify({
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    });
  };

  const exceptionOf = (name: string) =>
    tracing.spanNamed(name).events.find((e) => e.name === 'exception')?.attributes;

  it('records only the error type by default', () => {
    createTxTracker().startSend({ chainId: CHAIN_ID }).fail(sendError());

    expect(exceptionOf(`send ${CHAIN_ID}`)).toEqual({
      'exception.type': 'TransactionExecutionError',
    });
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(exported(`send ${CHAIN_ID}`)).not.toContain('insufficient funds');
  });

  it('never exports addresses from error messages in off mode', () => {
    for (const errorMessages of [undefined, 'sanitized', 'off'] as const) {
      tracing.exporter.reset();
      const tracker = createTxTracker({ address: 'off', errorMessages });
      tracker.startSend({ chainId: CHAIN_ID, from: FROM, to: TO }).fail(sendError());
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).fail(sendError());
      tracker.startSend({ chainId: CHAIN_ID }).fail(`rejected by ${FROM}`);

      for (const span of tracing.spans()) {
        const text = JSON.stringify({ a: span.attributes, e: span.events, s: span.status });
        expect(text.toLowerCase()).not.toContain(FROM.slice(2));
        expect(text.toLowerCase()).not.toContain(TO.slice(2));
      }
    }
  });

  it('records the first line with addresses per address mode and without calldata when sanitized', () => {
    createTxTracker({ address: 'off', errorMessages: 'sanitized' })
      .startSend({ chainId: CHAIN_ID })
      .fail(sendError());

    const message = 'insufficient funds for gas * price + value: address <address> have 0 want 1';
    expect(exceptionOf(`send ${CHAIN_ID}`)).toEqual({
      'exception.type': 'TransactionExecutionError',
      'exception.message': message,
    });
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).status.message).toBe(message);
  });

  it('keeps raw addresses but drops calldata when sanitized in raw address mode', () => {
    const error = new Error(`call to ${TO} with ${CALLDATA} failed`);
    createTxTracker({ errorMessages: 'sanitized' }).startSend({ chainId: CHAIN_ID }).fail(error);
    expect(exceptionOf(`send ${CHAIN_ID}`)?.['exception.message']).toBe(
      `call to ${TO} with <hex> failed`,
    );
  });

  it('hashes addresses in error messages in hashed mode', () => {
    createTxTracker({ address: 'hashed', errorMessages: 'sanitized' })
      .startSend({ chainId: CHAIN_ID })
      .fail(new Error(`rejected by ${FROM}`));
    expect(exceptionOf(`send ${CHAIN_ID}`)?.['exception.message']).toMatch(
      /^rejected by sha256:[0-9a-f]{32}$/,
    );
  });

  it('records the full message and stack trace only in raw mode', () => {
    const error = sendError();
    createTxTracker({ errorMessages: 'raw' }).startSend({ chainId: CHAIN_ID }).fail(error);
    expect(exceptionOf(`send ${CHAIN_ID}`)).toEqual({
      'exception.type': 'TransactionExecutionError',
      'exception.message': error.message,
      'exception.stacktrace': error.stack,
    });
  });

  it('runs the redaction hook on exception attributes', () => {
    createTxTracker({
      errorMessages: 'raw',
      redact: ({ 'exception.stacktrace': _stack, ...rest }) => ({
        ...rest,
        'exception.message': 'redacted',
      }),
    })
      .startSend({ chainId: CHAIN_ID })
      .fail(sendError());

    expect(exceptionOf(`send ${CHAIN_ID}`)).toEqual({
      'exception.type': 'TransactionExecutionError',
      'exception.message': 'redacted',
    });
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).status.message).toBe('redacted');
  });

  it('keeps only the error type when the redaction hook throws', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    createTxTracker({
      errorMessages: 'raw',
      redact: () => {
        throw new Error('boom');
      },
    })
      .startSend({ chainId: CHAIN_ID })
      .fail(sendError());
    expect(exceptionOf(`send ${CHAIN_ID}`)).toEqual({
      'exception.type': 'TransactionExecutionError',
    });
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).status).toEqual({ code: SpanStatusCode.ERROR });
  });

  it('applies the address mode to addresses in revert reasons', () => {
    createTxTracker({ address: 'off' })
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, status: 'reverted', revertReason: `Unauthorized(${FROM})` });
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).attributes['blockchain.tx.revert.reason']).toBe(
      'Unauthorized(<address>)',
    );
  });
});
