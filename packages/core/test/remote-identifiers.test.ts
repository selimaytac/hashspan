// Identifiers that a remote party chooses (a server, a facilitator, a wallet, an upstream caller's Baggage): in
// `hashed` and `off` address mode, one that holds 40 hex characters in a row (an address) is not recorded as it is.
// In `raw` mode they are recorded as before.
import { propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AddressMode, createTxTracker } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const HEX = ADDRESS.slice(2);
const HASH = `0x${'ab'.repeat(32)}`;
/** Values that hold an address: prefixed, unprefixed and inside other text. */
const HOLDING = [ADDRESS, HEX, `id-${HEX}-x`];
const HIDING: readonly AddressMode[] = ['hashed', 'off'];
const PAYMENT = {
  chainId: CHAIN_ID,
  protocol: 'x402',
  amount: 10_000n,
  x402: { scheme: 'exact', resource: 'https://api.example.com/weather' },
};
const MPP_PAYMENT = {
  chainId: CHAIN_ID,
  protocol: 'mpp',
  mpp: { method: 'tempo', intent: 'charge', resource: 'https://api.example.com/weather' },
};

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const only = (): ReadableSpan => {
  const [span, ...rest] = tracing.spans();
  expect(rest).toHaveLength(0);
  return span as ReadableSpan;
};
const attribute = (key: string, span: ReadableSpan = only()) => span.attributes[key];
const reset = () => tracing.exporter.reset();

describe.each([
  ['blockchain.payment.protocol', (value: string) => ({ ...PAYMENT, protocol: value }), 'x402'],
  ['x402.scheme', (value: string) => ({ ...PAYMENT, x402: { scheme: value } }), 'exact'],
  [
    'mpp.method',
    (value: string) => ({ ...MPP_PAYMENT, mpp: { ...MPP_PAYMENT.mpp, method: value } }),
    'tempo',
  ],
  [
    'mpp.intent',
    (value: string) => ({ ...MPP_PAYMENT, mpp: { ...MPP_PAYMENT.mpp, intent: value } }),
    'charge',
  ],
] as const)('%s', (key, input, plain) => {
  it.each(HIDING)('is not recorded when it holds an address, in %s mode', (address) => {
    const tracker = createTxTracker({ address });
    for (const value of HOLDING) {
      tracker.startPayment(input(value) as never).end({ status: 'settled' });
      expect(attribute(key), value).toBeUndefined();
      reset();
    }
    tracker.startPayment(input(plain) as never).end({ status: 'settled' });
    expect(attribute(key)).toBe(plain);
  });

  it('is recorded as given in raw mode', () => {
    const tracker = createTxTracker();
    for (const value of HOLDING) {
      tracker.startPayment(input(value) as never).end({ status: 'settled' });
      expect(attribute(key), value).toBe(value);
      reset();
    }
  });
});

describe.each(['x402', 'mpp'] as const)('%s.resource', (protocol) => {
  const key = `${protocol}.resource`;
  const pay = (resource: string) => ({ chainId: CHAIN_ID, protocol, [protocol]: { resource } });
  const holding = [`https://${HEX}.example`, `https://id-${HEX}-x.example/weather`];

  it.each(HIDING)('is not recorded when its host holds an address, in %s mode', (address) => {
    const tracker = createTxTracker({ address });
    for (const resource of holding) {
      tracker.startPayment(pay(resource) as never).end({ status: 'settled' });
      expect(attribute(key), resource).toBeUndefined();
      reset();
    }
    tracker
      .startPayment(pay('https://api.example.com/weather') as never)
      .end({ status: 'settled' });
    expect(attribute(key)).toBe('https://api.example.com');
  });

  it('is not recorded when its path holds an address without 0x, in hashed mode', () => {
    const tracker = createTxTracker({ address: 'hashed', paymentResource: 'path' });
    tracker
      .startPayment(pay(`https://api.example.com/u/${HEX}`) as never)
      .end({ status: 'settled' });
    expect(attribute(key)).toBeUndefined();
  });

  it('keeps a 0x address in its path formatted by the address mode, as before', () => {
    const tracker = createTxTracker({ address: 'hashed', paymentResource: 'path' });
    tracker
      .startPayment(pay(`https://api.example.com/u/${ADDRESS}`) as never)
      .end({ status: 'settled' });
    expect(attribute(key)).toMatch(/^https:\/\/api\.example\.com\/u\/sha256:[0-9a-f]{32}$/);
  });

  it('is recorded as before in raw mode', () => {
    const tracker = createTxTracker({ paymentResource: 'path' });
    for (const resource of holding) {
      tracker.startPayment(pay(resource) as never).end({ status: 'settled' });
      expect(attribute(key), resource).toBe(resource);
      reset();
    }
  });
});

describe('error.type from remote text', () => {
  const failures: [string, (tracker: ReturnType<typeof createTxTracker>, value: string) => void][] =
    [
      [
        'a settlement failure reason',
        (tracker, value) =>
          tracker.startPayment(PAYMENT as never).end({ status: 'failed', errorReason: value }),
      ],
      [
        "an adapter's error type of a payment",
        (tracker, value) =>
          tracker.startPayment(PAYMENT as never).fail(undefined, { errorType: value }),
      ],
      [
        "an adapter's error type of a send",
        (tracker, value) =>
          tracker.startSend({ chainId: CHAIN_ID }).fail(new Error('boom'), { errorType: value }),
      ],
    ];

  describe.each(failures)('%s', (_name, fail) => {
    it.each(HIDING)('is _OTHER when it holds an address without 0x, in %s mode', (address) => {
      const tracker = createTxTracker({ address });
      for (const value of [HEX, `id-${HEX}-x`]) {
        fail(tracker, value);
        expect(attribute('error.type'), value).toBe('_OTHER');
        reset();
      }
      // An address with `0x` follows the address mode, as before.
      fail(tracker, ADDRESS);
      expect(attribute('error.type')).toEqual(
        address === 'off' ? '<address>' : expect.stringMatching(/^sha256:[0-9a-f]{32}$/),
      );
      reset();
      fail(tracker, 'insufficient_funds');
      expect(attribute('error.type')).toBe('insufficient_funds');
    });

    it('is recorded as before in raw mode', () => {
      const tracker = createTxTracker();
      fail(tracker, HEX);
      expect(attribute('error.type')).toBe(HEX);
      reset();
      fail(tracker, `id-${HEX}-x`);
      expect(attribute('error.type')).toBe(`id-${HEX}-x`);
    });
  });

  it.each(HIDING)('is _OTHER for an error named with an address, in %s mode', (address) => {
    const named = new Error('boom');
    named.name = `Error${HEX}`;
    createTxTracker({ address }).startSend({ chainId: CHAIN_ID }).fail(named);
    const span = only();
    expect(attribute('error.type', span)).toBe('_OTHER');
    expect(span.events[0]?.attributes?.['exception.type']).toBe('_OTHER');
  });
});

describe('blockchain.call_batch.id', () => {
  const holding = [
    ADDRESS,
    `0x${'00'.repeat(12)}${HEX}`,
    `${ADDRESS}0000000000000000000000000000000000000000000000000000000000002105`,
  ];

  const ids = [...holding, '0xb47c4', `0x${'ab'.repeat(32)}`];
  /** Sends and confirms the batch `id`; returns its send and confirm spans. */
  const sendAndConfirm = (tracker: ReturnType<typeof createTxTracker>, id: string) => {
    tracker.startCallBatchSend({ chainId: CHAIN_ID, callCount: 1 }).end({ id });
    tracker.startCallBatchConfirm({ chainId: CHAIN_ID, id }).end({ statusCode: 200 });
    const spans = tracing.spans();
    expect(spans.map((span) => span.name)).toEqual([`send ${CHAIN_ID}`, `confirm ${CHAIN_ID}`]);
    // The batch is still keyed by its id: the confirm span links to the send span.
    expect(spans[1]?.links[0]?.context.spanId).toBe(spans[0]?.spanContext().spanId);
    return spans;
  };

  it('is hashed like an address in hashed mode, never recorded as it is', () => {
    const tracker = createTxTracker({ address: 'hashed' });
    const recorded = new Set<unknown>();
    for (const id of ids) {
      const spans = sendAndConfirm(tracker, id);
      const [send, confirm] = spans.map((span) => span.attributes['blockchain.call_batch.id']);
      expect(send, id).toMatch(/^sha256:[0-9a-f]{32}$/);
      // The same id has the same hash on both spans, and the hash does not depend on letter case.
      expect(confirm, id).toBe(send);
      reset();
      createTxTracker({ address: 'hashed' })
        .startCallBatchSend({ chainId: CHAIN_ID, callCount: 1 })
        .end({ id: id.toUpperCase().replace(/^0X/, '0x') });
      expect(attribute('blockchain.call_batch.id')).toBe(send);
      recorded.add(send);
      reset();
    }
    // Different ids keep different values, so batches stay apart.
    expect(recorded.size).toBe(ids.length);
  });

  it('uses the custom hash function of the address mode', () => {
    const tracker = createTxTracker({
      address: { mode: 'hashed', hash: (id) => `h:${id.length}` },
    });
    sendAndConfirm(tracker, ADDRESS);
    for (const span of tracing.spans())
      expect(span.attributes['blockchain.call_batch.id']).toBe('h:42');
  });

  it('is not recorded in off mode', () => {
    const tracker = createTxTracker({ address: 'off' });
    for (const id of ids) {
      for (const span of sendAndConfirm(tracker, id))
        expect(span.attributes['blockchain.call_batch.id'], id).toBeUndefined();
      reset();
    }
  });

  it('is recorded as before in raw mode', () => {
    const tracker = createTxTracker();
    for (const id of holding) {
      tracker.startCallBatchSend({ chainId: CHAIN_ID, callCount: 1 }).end({ id });
      expect(attribute('blockchain.call_batch.id'), id).toBe(id);
      reset();
    }
  });
});

describe('agent identity from Baggage', () => {
  const withBaggage = (value: string) =>
    propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({
        'gen_ai.agent.id': { value },
        'gen_ai.agent.name': { value },
      }),
    );
  const holding = [...HOLDING, `agent ${HEX} one`];

  it.each(HIDING)('is not recorded when it holds an address, in %s mode', (address) => {
    const tracker = createTxTracker({ address });
    for (const value of holding) {
      tracker.startSend({ chainId: CHAIN_ID }, withBaggage(value)).end({ hash: HASH });
      const span = only();
      expect(attribute('gen_ai.agent.id', span), value).toBeUndefined();
      expect(attribute('gen_ai.agent.name', span), value).toBeUndefined();
      reset();
    }
    tracker.startSend({ chainId: CHAIN_ID }, withBaggage('run-42')).end({ hash: HASH });
    expect(attribute('gen_ai.agent.id')).toBe('run-42');
  });

  it('is recorded as before in raw mode', () => {
    const tracker = createTxTracker();
    for (const value of holding) {
      tracker.startSend({ chainId: CHAIN_ID }, withBaggage(value)).end({ hash: HASH });
      expect(attribute('gen_ai.agent.id'), value).toBe(value);
      reset();
    }
  });

  it.each(HIDING)('keeps the static agent option as given, in %s mode', (address) => {
    createTxTracker({ address, agent: { id: HEX } })
      .startSend({ chainId: CHAIN_ID })
      .end({ hash: HASH });
    expect(attribute('gen_ai.agent.id')).toBe(HEX);
  });
});
