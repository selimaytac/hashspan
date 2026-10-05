import { diag, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'ab'.repeat(32)}`;
const ARGS = 'blockchain.contract.function.arguments';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const argumentsOf = (functionArguments: readonly unknown[]) => {
  tracing.exporter.reset();
  createTxTracker({ recordFunctionArguments: true })
    .startSend({ chainId: CHAIN_ID, functionName: 'call', functionArguments })
    .end({ hash: HASH });
  return tracing.spanNamed(`send ${CHAIN_ID}`).attributes[ARGS];
};

describe('function argument values', () => {
  it('writes null and false as JSON does', () => {
    expect(argumentsOf([null, false, { flag: false, none: null }])).toBe(
      '[null,false,{"flag":false,"none":null}]',
    );
  });

  it('writes NaN and infinities as null', () => {
    expect(
      argumentsOf([Number.NaN, Number.POSITIVE_INFINITY, { x: Number.NEGATIVE_INFINITY }]),
    ).toBe('[null,null,{"x":null}]');
  });

  it('drops arguments nested past the depth limit, and still ends the send span', () => {
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(argumentsOf([deep])).toBeUndefined();

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(send.attributes['blockchain.tx.hash']).toBe(HASH);
    expect(send.attributes['blockchain.contract.function.name']).toBe('call');
  });
});

describe('receipts', () => {
  it('accept numbers for block number and gas used', () => {
    createTxTracker()
      .startConfirm({ chainId: CHAIN_ID, hash: HASH })
      .end({ status: 'success', blockNumber: 123, gasUsed: 21_000, effectiveGasPrice: 2n });

    const confirm = tracing.spanNamed(`confirm ${CHAIN_ID}`);
    expect(confirm.status.code).toBe(SpanStatusCode.UNSET);
    expect(confirm.attributes).toMatchObject({
      'blockchain.block.number': 123,
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.fee': '42000',
    });
  });
});

describe('an unknown errorMessages value', () => {
  it('falls back to recording error types only, with a warning', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    createTxTracker({ errorMessages: 'everything' as never })
      .startSend({ chainId: CHAIN_ID })
      .fail(new Error('secret detail 0x2222222222222222222222222222222222222222'));

    const send = tracing.spanNamed(`send ${CHAIN_ID}`);
    const exception = send.events.find((e) => e.name === 'exception');
    expect(exception?.attributes?.['exception.type']).toBe('Error');
    expect(exception?.attributes?.['exception.message']).toBeUndefined();
    expect(exception?.attributes?.['exception.stacktrace']).toBeUndefined();
    expect(send.status.message).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown error message mode "everything"'),
    );
  });
});
