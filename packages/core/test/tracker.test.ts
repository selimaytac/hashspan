import {
  context,
  diag,
  INVALID_SPAN_CONTEXT,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
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
        .end({ hash: HASH });
    });
    tool.end();

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.kind).toBe(SpanKind.CLIENT);
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.instrumentationScope.name).toBe('@hashspan/core');
    expect(send.attributes).toMatchObject({
      'blockchain.system.name': 'evm',
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

  it("records an adapter's error type as error.type, keeping the class name as exception.type", () => {
    const tracker = createTxTracker();
    class APIError extends Error {
      override name = 'APIError';
    }
    tracker
      .startSend({ chainId: CHAIN_ID })
      .fail(new APIError('insufficient balance'), { errorType: 'insufficient_balance' });

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['error.type']).toBe('insufficient_balance');
    expect(send.events[0]?.attributes?.['exception.type']).toBe('APIError');
  });

  it('records the class name when the error type is not a short identifier', () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const tracker = createTxTracker();
    for (const errorType of ['has spaces', 'x'.repeat(65), '', 42 as unknown as string]) {
      tracker.startSend({ chainId: CHAIN_ID }).fail(new TypeError('bad'), { errorType });
    }
    tracker.startSend({ chainId: CHAIN_ID }).fail(new TypeError('bad'), {});
    const types = tracing.spans().map((s) => s.attributes['error.type']);
    expect(types).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError']);
  });

  it('ignores repeated end/fail calls', () => {
    const tracker = createTxTracker();
    const handle = tracker.startSend({ chainId: CHAIN_ID });
    handle.end({ hash: HASH });
    handle.fail(new Error('late'));
    handle.end({ hash: HASH });
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe('confirm span', () => {
  it('links to the send span and records receipt data and fees', () => {
    const tracker = createTxTracker();
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
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
    tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
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
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
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
    expect(confirm.attributes['error.type']).toBe('timeout');
    // Giving up says nothing about the transaction (ADR 0016).
    expect(confirm.attributes['blockchain.tx.status']).toBeUndefined();
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

describe('agent identity from untrusted baggage', () => {
  it('cannot override the configured agent, and is ignored with agentFromBaggage: false', () => {
    const inbound = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({
        'gen_ai.agent.id': { value: 'forged' },
        'gen_ai.agent.name': { value: 'someone-else' },
      }),
    );
    context.with(inbound, () => {
      createTxTracker({ agent: { name: 'treasury-bot' } })
        .startSend({ chainId: CHAIN_ID })
        .end({ hash: HASH });
      createTxTracker({ agent: { name: 'treasury-bot' }, agentFromBaggage: false })
        .startSend({ chainId: CHAIN_ID })
        .end({ hash: HASH });
    });

    const [trusting, ignoring] = tracing.spans();
    expect(trusting?.attributes).toMatchObject({
      'gen_ai.agent.id': 'forged',
      'gen_ai.agent.name': 'treasury-bot',
    });
    expect(ignoring?.attributes['gen_ai.agent.name']).toBe('treasury-bot');
    expect(ignoring?.attributes['gen_ai.agent.id']).toBeUndefined();
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
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
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
      .end({ hash: HASH });
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(send.attributes['blockchain.tx.to']).toBeUndefined();
  });

  it('hashes addresses in hashed mode', () => {
    createTxTracker({ address: 'hashed' })
      .startSend({ chainId: CHAIN_ID, from: FROM })
      .end({ hash: HASH });
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
    tracker
      .startSend({ chainId: CHAIN_ID, value: 5n, functionName: 'transfer' })
      .end({ hash: HASH });
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
    tracker.startSend({ chainId: CHAIN_ID, from: FROM, to: TO, value: 5n }).end({ hash: HASH });

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
      tracker.startSend({ chainId: CHAIN_ID }, explicitCtx).end({ hash: HASH });
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
    tracker.startSend({ chainId: CHAIN_ID, from: FROM }).end({ hash: HASH });
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
      .end({ hash: HASH });
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
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    }).not.toThrow();
    expect(diagError).toHaveBeenCalled();
  });

  it('swallows errors from ending a span', () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => {});
    const span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    span.end = () => {
      throw new Error('broken span');
    };
    const tracker = createTxTracker({
      tracerProvider: { getTracer: () => ({ ...trace.getTracer('test'), startSpan: () => span }) },
    });
    expect(() => {
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
      tracker.startSend({ chainId: CHAIN_ID }).fail(new Error('send failed'));
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).timeout();
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

  it('keeps only the origin of URLs in sanitized messages, which can carry API keys in the path or query', () => {
    const error = new Error(
      'request to https://user:pw@rpc.example.com:8545/v2/k3y?apikey=s3cret failed, retried wss://ws.example.com/k3y.',
    );
    createTxTracker({ errorMessages: 'sanitized' }).startSend({ chainId: CHAIN_ID }).fail(error);
    createTxTracker({ errorMessages: 'sanitized' })
      .startSend({ chainId: CHAIN_ID })
      .fail(new Error('fetch https://user:p?ss@rpc.example.com/k3y failed'));
    expect(
      tracing
        .spans()
        .map(
          (span) =>
            span.events.find((e) => e.name === 'exception')?.attributes?.['exception.message'],
        ),
    ).toEqual([
      'request to https://rpc.example.com:8545 failed, retried wss://ws.example.com',
      'fetch <url> failed',
    ]);
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

  it('applies the address mode and the redaction hook to dynamic error names', () => {
    const error = new Error('rejected');
    error.name = `RejectedBy${FROM}`;

    createTxTracker({ address: 'off' }).startSend({ chainId: CHAIN_ID }).fail(error);
    const text = exported(`send ${CHAIN_ID}`).toLowerCase();
    expect(text).not.toContain(FROM.slice(2));
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).attributes['error.type']).toBe(
      'RejectedBy<address>',
    );

    tracing.exporter.reset();
    createTxTracker({
      redact: ({ 'error.type': _type, 'exception.type': _exception, ...rest }) => rest,
    })
      .startSend({ chainId: CHAIN_ID })
      .fail(error);
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['error.type']).toBeUndefined();
    expect(exceptionOf(`send ${CHAIN_ID}`)).toEqual({});
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
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

describe('concurrent confirmations', () => {
  const confirms = () => tracing.spans().filter((s) => s.name === `confirm ${CHAIN_ID}`);

  it('joins handles for the same transaction into one confirm span', () => {
    const tracker = createTxTracker();
    const first = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    const second = tracker.startConfirm({
      chainId: CHAIN_ID,
      hash: HASH.toUpperCase().replace('0X', '0x'),
    });
    first.end(receipt);
    second.end(receipt);
    expect(confirms()).toHaveLength(1);
  });

  it('keeps the parent of the first handle', () => {
    const tracker = createTxTracker();
    const firstParent = trace.getTracer('test').startSpan('first');
    const secondParent = trace.getTracer('test').startSpan('second');
    const first = tracker.startConfirm(
      { chainId: CHAIN_ID, hash: HASH },
      trace.setSpan(context.active(), firstParent),
    );
    tracker
      .startConfirm(
        { chainId: CHAIN_ID, hash: HASH },
        trace.setSpan(context.active(), secondParent),
      )
      .end(receipt);
    first.timeout();
    expect(confirms()[0]?.parentSpanContext?.spanId).toBe(firstParent.spanContext().spanId);
  });

  it('records a later receipt when another handle gave up first', () => {
    const tracker = createTxTracker();
    const background = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    const caller = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    background.timeout();
    expect(confirms()).toHaveLength(0);
    caller.end(receipt);
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBe('success');
    expect(confirms()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('ends with the outcome of the last handle to give up', () => {
    const tracker = createTxTracker();
    const first = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    const second = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    first.fail(new Error('rpc down'));
    second.timeout();
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(confirms()[0]?.attributes['error.type']).toBe('timeout');
  });

  it('ignores calls after the span ended', () => {
    const tracker = createTxTracker();
    const first = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    const second = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    first.end(receipt);
    second.fail(new Error('late'));
    second.end({ ...receipt, status: 'reverted' });
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('adds no span for a transaction that already has a receipt', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirms()).toHaveLength(1);
  });

  it('traces a retry after a timeout or failure as a new span', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).timeout();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).fail(new Error('rpc down'));
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(
      confirms().map((s) => [s.attributes['blockchain.tx.status'], s.attributes['error.type']]),
    ).toEqual([
      [undefined, 'timeout'],
      [undefined, 'Error'],
      ['success', undefined],
    ]);
  });

  it('keeps chains apart', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: 1, hash: HASH }).end(receipt);
    tracker.startConfirm({ chainId: 10, hash: HASH }).end(receipt);
    expect(tracing.spans().map((s) => s.name)).toEqual(['confirm 1', 'confirm 10']);
  });

  it('forgets settled transactions after the link TTL', () => {
    vi.useFakeTimers();
    try {
      const tracker = createTxTracker({ linkTtlMs: 1_000 });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      vi.advanceTimersByTime(1_001);
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
      expect(confirms()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a second span for a key evicted while in flight', () => {
    const tracker = createTxTracker({ maxTrackedTransactions: 1 });
    const evicted = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: `0x${'01'.repeat(32)}` });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    evicted.end(receipt);
    expect(confirms().filter((s) => s.attributes['blockchain.tx.hash'] === HASH)).toHaveLength(2);
  });
});

describe('replaced transactions', () => {
  const MINED = `0x${'cd'.repeat(32)}`;
  const confirmOf = (hash: string) =>
    tracing
      .spans()
      .filter(
        (s) => s.name === `confirm ${CHAIN_ID}` && s.attributes['blockchain.tx.hash'] === hash,
      );
  const replacedReceipt = {
    ...receipt,
    transactionHash: MINED,
    replacementReason: 'cancelled' as const,
  };

  it('ends the original as replaced and records the receipt on the mined transaction', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: MINED });
      tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replacedReceipt);
    });
    tool.end();

    const [original] = confirmOf(HASH);
    const [mined] = confirmOf(MINED);
    expect(original?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': MINED,
      'blockchain.tx.replacement.reason': 'cancelled',
    });
    for (const key of ['blockchain.block.number', 'blockchain.tx.gas.used', 'blockchain.tx.fee']) {
      expect(original?.attributes[key]).toBeUndefined();
    }
    expect(original?.attributes['error.type']).toBeUndefined();
    expect(original?.status.code).toBe(SpanStatusCode.UNSET);

    expect(mined?.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.fee': '21000000000000',
    });
    expect(mined?.attributes['blockchain.tx.replacement.reason']).toBeUndefined();
    expect(mined?.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(mined?.startTime).toEqual(original?.startTime);
    const sendOf = (hash: string) =>
      tracing
        .spans()
        .find((s) => s.name === `send ${CHAIN_ID}` && s.attributes['blockchain.tx.hash'] === hash)
        ?.spanContext().spanId;
    expect(mined?.links.map((l) => l.context.spanId).sort()).toEqual(
      [original?.spanContext().spanId, sendOf(HASH), sendOf(MINED)].sort(),
    );
  });

  it('starts the mined transaction exactly when the replaced one started', () => {
    // A wall clock that turns a millisecond after every read, as it can between the SDK's read and a later one.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 });
    try {
      const read = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => {
        const now = read();
        vi.setSystemTime(now + 1);
        return now;
      });
      for (let round = 0; round < 20; round++) {
        const awaited = `0x${round.toString(16).padStart(64, '0')}`;
        const mined = `0x${(round + 1000).toString(16).padStart(64, '0')}`;
        createTxTracker()
          .startConfirm({ chainId: CHAIN_ID, hash: awaited })
          .end({ ...receipt, transactionHash: mined });
        expect(confirmOf(mined)[0]?.startTime).toEqual(confirmOf(awaited)[0]?.startTime);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  /** A tracer provider whose spans delegate to the SDK's; `define` gives them a `startTime`, if any. */
  const wrappingProvider = (define?: (span: object) => void): TracerProvider => ({
    getTracer: (...args) => {
      const tracer = trace.getTracerProvider().getTracer(...args);
      return {
        startSpan: (name, options, ctx) => {
          const real = tracer.startSpan(name, options, ctx) as unknown as Record<
            string,
            (...args: unknown[]) => unknown
          >;
          const wrapped: Record<string, unknown> = {};
          for (const method of [
            'spanContext',
            'setAttribute',
            'setAttributes',
            'addEvent',
            'addLink',
            'addLinks',
            'setStatus',
            'updateName',
            'end',
            'isRecording',
            'recordException',
          ]) {
            wrapped[method] = (...args: unknown[]) => {
              const result = real[method]?.(...args);
              return result === real ? wrapped : result;
            };
          }
          define?.(wrapped);
          return wrapped as unknown as Span;
        },
        startActiveSpan: tracer.startActiveSpan.bind(tracer),
      } as Tracer;
    },
  });
  const msOf = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);

  it("takes the start time a span records as an own data property, never the caller's array", () => {
    const startTime: [number, number] = [1_700_000_000, 123_456_789];
    createTxTracker({
      tracerProvider: wrappingProvider((span) => Object.assign(span, { startTime })),
    })
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end(replacedReceipt);
    startTime[1] = 0;
    expect(confirmOf(MINED)[0]?.startTime).toEqual([1_700_000_000, 123_456_789]);
  });

  let getterCalls = 0;
  const throwing = () => {
    getterCalls++;
    throw new Error('getter ran');
  };

  it.each<[string, ((span: object) => void) | undefined]>([
    ['no start time', undefined],
    [
      'a start time behind a getter that throws',
      (span) => Object.defineProperty(span, 'startTime', { get: throwing }),
    ],
    ['a start time of one number', (span) => Object.assign(span, { startTime: [1] })],
    ['a start time of three numbers', (span) => Object.assign(span, { startTime: [1, 2, 3] })],
    ['a negative start time', (span) => Object.assign(span, { startTime: [-1, 0] })],
    ['a NaN start time', (span) => Object.assign(span, { startTime: [Number.NaN, 0] })],
    ['an infinite start time', (span) => Object.assign(span, { startTime: [0, Infinity] })],
    ['a start time of strings', (span) => Object.assign(span, { startTime: ['1', '0'] })],
    ['a start time that is a number', (span) => Object.assign(span, { startTime: 1 })],
    [
      'an array-like start time',
      (span) => Object.assign(span, { startTime: { 0: 1, 1: 0, length: 2 } }),
    ],
    [
      'a start time with an element behind a getter',
      (span) => {
        const startTime = [1, 0];
        Object.defineProperty(startTime, 0, { get: throwing });
        Object.assign(span, { startTime });
      },
    ],
  ])('falls back to the wall clock for spans with %s', (_, define) => {
    getterCalls = 0;
    const errors = vi.spyOn(diag, 'error');
    const before = Date.now();
    expect(() =>
      createTxTracker({ tracerProvider: wrappingProvider(define) })
        .startConfirm({ chainId: CHAIN_ID, hash: HASH })
        .end(replacedReceipt),
    ).not.toThrow();
    const after = Date.now();
    const [original] = confirmOf(HASH);
    const [mined] = confirmOf(MINED);
    expect(original?.attributes['blockchain.tx.status']).toBe('replaced');
    expect(mined?.attributes['blockchain.tx.status']).toBe('success');
    // A start taken from the wall clock: whole milliseconds, within the call.
    const start = msOf(mined?.startTime);
    expect(Number.isInteger(start)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    expect(errors).not.toHaveBeenCalled();
    expect(getterCalls).toBe(0);
  });

  it('marks a reverted replacing transaction as an error on its own span only', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...replacedReceipt, status: 'reverted' });
    expect(confirmOf(HASH)[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirmOf(MINED)[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirmOf(MINED)[0]?.attributes['blockchain.tx.status']).toBe('reverted');
  });

  it('records no reason when none was reported, and drops unknown reasons', () => {
    const tracker = createTxTracker();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: MINED });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: `0x${'01'.repeat(32)}` }).end({
      ...receipt,
      transactionHash: `0x${'02'.repeat(32)}`,
      replacementReason: 'x' as never,
    });
    const replaced = tracing
      .spans()
      .filter((s) => s.attributes['blockchain.tx.status'] === 'replaced');
    expect(replaced).toHaveLength(2);
    for (const span of replaced) {
      expect(span.attributes['blockchain.tx.replacement.reason']).toBeUndefined();
      expect(span.attributes['blockchain.tx.replacement.hash']).toBeDefined();
    }
  });

  it('treats a differently cased hash as the same transaction', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: HASH.toUpperCase().replace('0X', '0x') });
    expect(confirmOf(HASH)[0]?.attributes['blockchain.tx.status']).toBe('success');
    expect(tracing.spans()).toHaveLength(1);
  });

  it('attributes nothing to an invalid receipt hash', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const tracker = createTxTracker();
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: `nope ${FROM}` });

    expect(tracing.spans()).toHaveLength(1);
    const [original] = confirmOf(HASH);
    expect(original?.status.code).toBe(SpanStatusCode.ERROR);
    expect(original?.attributes['error.type']).toBe('_OTHER');
    for (const key of ['blockchain.tx.status', 'blockchain.tx.gas.used', 'blockchain.tx.fee']) {
      expect(original?.attributes[key]).toBeUndefined();
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(FROM);

    // A non-string hash is not attributed either.
    tracker
      .startConfirm({ chainId: CHAIN_ID, hash: `0x${'03'.repeat(32)}` })
      .end({ ...receipt, transactionHash: 42 as never });
    expect(tracing.spans()).toHaveLength(2);
    expect(tracing.spans()[1]?.attributes['error.type']).toBe('_OTHER');

    // Released like a failure: a retry starts a new span.
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    expect(confirmOf(HASH)).toHaveLength(2);
  });

  it('ignores a joined handle of the original after the replacement was recorded', () => {
    const tracker = createTxTracker();
    const first = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    const second = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH });
    first.end(replacedReceipt);
    second.end(replacedReceipt);
    second.end({ ...replacedReceipt, transactionHash: `0x${'09'.repeat(32)}` });
    expect(confirmOf(HASH)).toHaveLength(1);
    expect(confirmOf(MINED)).toHaveLength(1);
    expect(tracing.spans()).toHaveLength(2);
  });

  it('keeps the monotonic clock for spans that are not replacements', () => {
    createTxTracker().startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(receipt);
    // Reads an SDK internal: with an explicit start time, the SDK ends spans by the wall clock.
    // Reads an SDK internal (sdk-trace-base Span): with a start time passed in, the SDK measures by the wall clock.
    const span = confirmOf(HASH)[0] as unknown as { _startTimeProvided?: boolean };
    expect(span._startTimeProvided).toBe(false);
  });

  it('validates the receipt hash before comparing it with the awaited hash', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ ...receipt, transactionHash: 'NOT-A-HASH' });
    const [span] = tracing.spans();
    expect(span?.attributes['error.type']).toBe('_OTHER');
    expect(span?.attributes['blockchain.tx.status']).toBeUndefined();
    expect(span?.attributes['blockchain.tx.fee']).toBeUndefined();
  });

  it('settles the original, so later waits for it add no span', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replacedReceipt);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replacedReceipt);
    expect(confirmOf(HASH)).toHaveLength(1);
    expect(confirmOf(MINED)).toHaveLength(1);
  });

  it('ends an in-flight confirm span of the mined transaction instead of adding one', () => {
    const tracker = createTxTracker();
    const waitingForMined = tracker.startConfirm({ chainId: CHAIN_ID, hash: MINED });
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replacedReceipt);
    expect(confirmOf(MINED)).toHaveLength(1);
    expect(confirmOf(MINED)[0]?.attributes['blockchain.tx.status']).toBe('success');
    waitingForMined.end(receipt);
    expect(confirmOf(MINED)).toHaveLength(1);
  });

  it('adds no span for a mined transaction that already has a receipt', () => {
    const tracker = createTxTracker();
    tracker.startConfirm({ chainId: CHAIN_ID, hash: MINED }).end(receipt);
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(replacedReceipt);
    expect(confirmOf(MINED)).toHaveLength(1);
    expect(confirmOf(HASH)[0]?.attributes['blockchain.tx.status']).toBe('replaced');
  });

  it('keeps replacement attributes when the redaction hook fails', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    createTxTracker({
      redact: () => {
        throw new Error('boom');
      },
    })
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end(replacedReceipt);
    expect(confirmOf(HASH)[0]?.attributes).toMatchObject({
      'blockchain.tx.status': 'replaced',
      'blockchain.tx.replacement.hash': MINED,
      'blockchain.tx.replacement.reason': 'cancelled',
    });
  });
});

describe('explicit start and end times', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
  const ms = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);

  it('records a send span with the given start and end times', () => {
    createTxTracker()
      .startSend({ chainId: CHAIN_ID, startTime: at(100) })
      .end({ hash: HASH }, { endTime: at(350) });
    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(ms(send.startTime)).toBe(at(100).getTime());
    expect(ms(send.endTime)).toBe(at(350).getTime());
  });

  it('records a failed send with the given end time', () => {
    createTxTracker()
      .startSend({ chainId: CHAIN_ID, startTime: at(100) })
      .fail(new Error('rejected'), { endTime: at(200) });
    expect(ms(tracing.spanNamed(`send ${CHAIN_ID}`).endTime)).toBe(at(200).getTime());
  });

  it('records a confirm span with the given times, the last withdrawing handle ending it', () => {
    const tracker = createTxTracker();
    const first = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, startTime: at(100) });
    const second = tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH, startTime: at(900) });
    first.timeout({ endTime: at(500) });
    second.timeout({ endTime: at(700) });
    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(ms(confirm.startTime)).toBe(at(100).getTime());
    expect(ms(confirm.endTime)).toBe(at(700).getTime());
  });

  it('starts a replacing transaction span at the explicit start of the replaced one', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH, startTime: at(100) })
      .end({ ...receipt, transactionHash: `0x${'cd'.repeat(32)}` }, { endTime: at(400) });
    for (const span of tracing.spans()) {
      expect(ms(span.startTime)).toBe(at(100).getTime());
      expect(ms(span.endTime)).toBe(at(400).getTime());
    }
    expect(tracing.spans()).toHaveLength(2);
  });
});
