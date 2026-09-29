import { diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'ab'.repeat(32)}`;
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const ATTR = 'blockchain.contract.function.arguments';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const sendWith = (
  options: Parameters<typeof createTxTracker>[0],
  functionArguments: readonly unknown[],
) => {
  createTxTracker(options)
    .startSend({ chainId: CHAIN_ID, functionName: 'transfer', functionArguments })
    .end(HASH);
  return tracing.spanNamed(`send ${CHAIN_ID}`).attributes[ATTR];
};

describe('function arguments', () => {
  it('are not recorded by default', () => {
    expect(sendWith({}, [RECIPIENT, 5n])).toBeUndefined();
  });

  it('are recorded as a JSON array when enabled, with bigints as decimal strings', () => {
    expect(sendWith({ recordFunctionArguments: true }, [RECIPIENT, 10n ** 30n, true, 'memo'])).toBe(
      `["${RECIPIENT}","1000000000000000000000000000000",true,"memo"]`,
    );
  });

  it('serialize nested arrays and structs', () => {
    const order = { maker: RECIPIENT, amounts: [1n, 2n] };
    expect(sendWith({ recordFunctionArguments: true }, [[order]])).toBe(
      `[[{"maker":"${RECIPIENT}","amounts":["1","2"]}]]`,
    );
  });

  it('follow the address mode', () => {
    expect(sendWith({ recordFunctionArguments: true, address: 'off' }, [RECIPIENT, 5n])).toBe(
      '["<address>","5"]',
    );
    tracing.exporter.reset();
    expect(sendWith({ recordFunctionArguments: true, address: 'hashed' }, [RECIPIENT])).toMatch(
      /^\["sha256:[0-9a-f]{32}"\]$/,
    );
  });

  it('are truncated when very long', () => {
    const value = sendWith({ recordFunctionArguments: true }, ['x'.repeat(10_000)]);
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeLessThanOrEqual(4096 + 3);
    expect(value as string).toMatch(/\.\.\.$/);
  });

  it('are dropped when the redaction hook fails', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const value = sendWith(
      {
        recordFunctionArguments: true,
        redact: () => {
          throw new Error('boom');
        },
      },
      [RECIPIENT],
    );
    expect(value).toBeUndefined();
    expect(tracing.spanNamed(`send ${CHAIN_ID}`).attributes['blockchain.tx.hash']).toBe(HASH);
  });

  it('never break the send when they cannot be serialized', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sendWith({ recordFunctionArguments: true }, [cyclic])).toBeUndefined();
    expect(
      tracing.spanNamed(`send ${CHAIN_ID}`).attributes['blockchain.contract.function.name'],
    ).toBe('transfer');
  });
});
