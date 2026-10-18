// ADR 0025: the observers `withHashspan(mppx, { reader })` registers on an mppx client, with the hostile-input table of
// `core/test/hostile.ts` applied to what the paid server sends (the challenge, its request and splits, the paid
// response and its `Payment-Receipt` header, the receipt the reader returns), to what the payer's client hands them
// (the credential and its JSON, the request input, errors), and to the reader, tracker and client passed in. An
// observer has no untraced counterpart: it must return nothing and never throw, and what it records must keep the
// rules. A rule that does not hold yet is marked `it.fails` with `// finding: <tag>`.
import { Attribution } from 'mppx/tempo';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbi,
} from 'viem';
import { tempo as tempoChain } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESS,
  type AdapterRow,
  type AdapterScenario,
  addressAcrossCut,
  BOUNDS,
  describeAdapterRows,
  type HostileTracing,
  hostileErrors,
  hostileValues,
  recordingMeterProvider,
  revokedProxy,
  SECRET,
  setupHostileTracing,
  splitsHex,
  throwingGetters,
  throwingProxy,
} from '../../core/test/hostile.js';
import { mockTransport, HASH as RECEIPT_HASH } from '../../viem/test/mock-transport.js';
import { type WithHashspanMppOptions, withHashspan } from '../src/index.js';
import {
  CURRENCY,
  challengeOf,
  fakeClient,
  PAYER,
  REALM,
  RECIPIENT,
  receiptHeader,
} from './fake-mppx.js';

let tracing: HostileTracing;
const meters = recordingMeterProvider();
beforeAll(() => {
  tracing = setupHostileTracing();
});
afterAll(async () => {
  await tracing.teardown();
});

const CHALLENGE_ID = 'qB3wVm6v2Jt4Xk9rLp0sZ_aQ-1yHc8NdEfGhIjKlMnO';
const TIP20 = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
]);
/** The logs of the default payment's settlement, as a node returns them. */
const settlementLogs = () => {
  const args = { from: PAYER.address as Hex, to: RECIPIENT as Hex };
  const memo = Attribution.encode({ challengeId: CHALLENGE_ID, serverId: REALM }) as Hex;
  return [
    encodeEventTopics({ abi: TIP20, eventName: 'Transfer', args }),
    encodeEventTopics({ abi: TIP20, eventName: 'TransferWithMemo', args: { ...args, memo } }),
  ].map((topics, index) => ({
    address: CURRENCY,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }], [10_000n]),
    blockNumber: '0x7b',
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionHash: RECEIPT_HASH,
    transactionIndex: '0x0',
    logIndex: `0x${index}`,
    removed: false,
  }));
};
const readerWith = (receipt: Record<string, unknown> = {}) =>
  createPublicClient({
    chain: tempoChain,
    transport: mockTransport({
      chainIdHex: '0x1079',
      receipt: { logs: settlementLogs(), ...receipt },
    }).transport,
    pollingInterval: 10,
  });

/** Encodes `json` as mppx encodes a credential or a receipt; a value JSON cannot hold is passed on as it is. */
function encoded(json: unknown, prefix = ''): unknown {
  try {
    return `${prefix}${Buffer.from(JSON.stringify(json)).toString('base64url')}`;
  } catch {
    return json;
  }
}

/** One payment's event payloads, each of which a row can make hostile. */
interface Payment {
  challenge: Record<string, unknown>;
  /** The credential's JSON; `credential` is encoded from it unless a row sets it. */
  credentialJson: Record<string, unknown>;
  credential?: unknown;
  /** The `Payment-Receipt` JSON; the header is encoded from it unless a row sets it. */
  receiptJson: Record<string, unknown>;
  header?: unknown;
  /** The paid response's copy; a `Response` with the header unless a row sets it. */
  response?: unknown;
  input: unknown;
  /** Set to make the payment fail with this error instead of getting a response. */
  error?: unknown;
  /** Set to make the payment fail before its credential, with this error. */
  earlyError?: unknown;
}

function payment(): Payment {
  const challenge = challengeOf({ id: CHALLENGE_ID });
  return {
    challenge,
    credentialJson: {
      challenge: { ...challenge, request: 'eyJ9' },
      payload: { type: 'hash', hash: RECEIPT_HASH },
      source: `did:pkh:eip155:4217:${PAYER.address}`,
    },
    receiptJson: {
      method: 'tempo',
      reference: RECEIPT_HASH,
      status: 'success',
      timestamp: '2026-10-18T00:00:00.000Z',
    },
    input: 'https://api.example.com/weather',
  };
}

type Row = AdapterRow<WithHashspanMppOptions>;

/** Runs `pay` (after `change` made it hostile) through the observers of a traced client; a return or a throw fails it. */
const paying =
  (
    change: (pay: Payment, value: unknown) => void,
    readerReceipt?: (value: unknown) => Record<string, unknown>,
  ) =>
  (value: unknown, options: WithHashspanMppOptions | undefined): AdapterScenario => {
    const fake = fakeClient();
    // Made in the call, so that a setup that throws counts as the call throwing.
    let hashspan: ReturnType<typeof withHashspan> | undefined;
    return {
      call: async () => {
        hashspan = withHashspan(fake.client, {
          reader: readerWith(readerReceipt?.(value)),
          confirmTimeoutMs: 2_000,
          // The failure rows need the payment.failed observer.
          observeFailures: true,
          ...options,
        });
        const pay = payment();
        change(pay, value);
        const credential =
          'credential' in pay ? pay.credential : encoded(pay.credentialJson, 'Payment ');
        const header = 'header' in pay ? pay.header : encoded(pay.receiptJson);
        const response =
          'response' in pay
            ? pay.response
            : new Response(
                '{}',
                typeof header === 'string' ? { headers: { 'payment-receipt': header } } : {},
              );
        const run = async (name: string, payload: unknown) => {
          for (const returned of await fake.emit(name, payload)) {
            if (returned !== undefined)
              throw new TypeError(`the ${name} observer returned a value`);
          }
        };
        const { challenge, input } = pay;
        await run('challenge.received', { challenge, input });
        if ('earlyError' in pay) {
          await run('payment.failed', { challenge, error: pay.earlyError, input });
          return;
        }
        await run('credential.created', { challenge, credential, input });
        if ('error' in pay) {
          await run('payment.failed', { challenge, error: pay.error, input });
          return;
        }
        await run('payment.response', { challenge, credential, input, response });
      },
      flush: async () => (hashspan ? hashspan.flush({ timeoutMs: 3_000 }) : true),
    };
  };

/** A row for each field of the object `of(pay)` returns. */
function fieldRows(name: string, of: (pay: Payment) => Record<string, unknown>): Row[] {
  return Object.keys(of(payment())).map(
    (key): Row => ({
      name: `${name} ${key}`,
      untraced: false,
      scenario: paying((pay, value) => {
        of(pay)[key] = value;
      }),
    }),
  );
}

const request = (pay: Payment) => pay.challenge.request as Record<string, unknown>;
const details = (pay: Payment) => request(pay).methodDetails as Record<string, unknown>;
const SPLIT = { amount: '1000', recipient: '0x00000000000000000000000000000000000000dd' };

/** An `PaymentOutcomeUnknownError` as mppx throws it: its name and `transactionHash` are own data properties. */
function outcomeUnknown(transactionHash: unknown): Error {
  const error = new Error('Payment outcome is unknown');
  Object.defineProperty(error, 'name', { value: 'PaymentOutcomeUnknownError', enumerable: true });
  Object.defineProperty(error, 'transactionHash', { value: transactionHash, enumerable: true });
  return error;
}

const ROWS: Row[] = [
  // Each payload field the observers read, whole.
  ...(['challenge', 'credential', 'header', 'response', 'input'] as const).map(
    (key): Row => ({
      name: `event payload ${key}`,
      untraced: false,
      scenario: paying((pay, value) => {
        pay[key] = value as never;
      }),
    }),
  ),
  // What the paid server asks for.
  ...fieldRows('challenge', (pay) => pay.challenge),
  ...fieldRows('challenge request', request),
  ...fieldRows('challenge methodDetails', details),
  {
    name: 'challenge split',
    untraced: false,
    scenario: paying((pay, value) => {
      details(pay).splits = [value];
    }),
  },
  ...fieldRows('challenge split', (pay) => {
    const split = { ...SPLIT };
    details(pay).splits = [split];
    return split;
  }),
  {
    name: 'challenge with 11 splits',
    untraced: false,
    values: () => [
      ['11 splits', Array.from({ length: 11 }, () => ({ ...SPLIT }))],
      ['100 000 splits', Array.from({ length: 100_000 }, () => ({ ...SPLIT }))],
      ['splits whose total is the amount', [{ amount: '10000', recipient: SPLIT.recipient }]],
    ],
    scenario: paying((pay, value) => {
      details(pay).splits = value;
    }),
  },
  {
    // The server chooses the id: one that is an address stays hidden in hashed and off mode (rule 6).
    name: 'challenge id holding an address',
    untraced: false,
    values: () => [
      ['an address', ADDRESS],
      ['an address without 0x', ADDRESS.slice(2)],
      ['an id around an address', `id-${ADDRESS.slice(2)}-x`],
    ],
    scenario: paying((pay, value) => {
      pay.challenge.id = value;
    }),
  },
  {
    name: 'challenge id, repeated',
    untraced: false,
    scenario: paying((pay, value) => {
      pay.challenge.id = value;
      pay.credentialJson.challenge = pay.challenge;
    }),
  },
  // What the payer's client hands the observers: the credential's JSON.
  ...fieldRows('credential', (pay) => pay.credentialJson),
  ...fieldRows(
    'credential payload',
    (pay) => pay.credentialJson.payload as Record<string, unknown>,
  ),
  {
    name: 'credential payload signature (pull)',
    untraced: false,
    scenario: paying((pay, value) => {
      pay.credentialJson.payload = { type: 'transaction', signature: value };
    }),
  },
  // What the paid server answers: the receipt header's JSON.
  ...fieldRows('Payment-Receipt', (pay) => pay.receiptJson),
  {
    name: 'paid response copy that is not a Response',
    untraced: false,
    values: () => [
      [
        'a plain object with headers',
        { headers: new Headers({ 'payment-receipt': receiptHeader(RECEIPT_HASH) }) },
      ],
      [
        'an object with a throwing headers getter',
        throwingGetters(['headers', 'body', 'bodyUsed']),
      ],
      [
        'a Response whose own headers getter throws',
        Object.defineProperty(new Response('{}'), 'headers', {
          get: () => {
            throw new Error('headers');
          },
        }),
      ],
      ...hostileValues(),
    ],
    scenario: paying((pay, value) => {
      pay.response = value;
    }),
  },
  {
    name: 'request input that is not a platform object',
    untraced: false,
    values: () => [
      ['an object with a url', { url: `https://api.example.com/${SECRET}` }],
      [
        'a Request whose own url getter throws',
        Object.defineProperty(new Request('https://api.example.com/'), 'url', {
          get: () => {
            throw new Error('url');
          },
        }),
      ],
      ...hostileValues(),
    ],
    scenario: paying((pay, value) => {
      pay.input = value;
    }),
  },
  {
    name: 'payment failure after the credential',
    untraced: false,
    values: () => [
      ...hostileErrors(),
      ...hostileValues().map(([label, value]): [string, unknown] => [
        `an outcome-unknown error whose transactionHash is ${label}`,
        outcomeUnknown(value),
      ]),
    ],
    scenario: paying((pay, value) => {
      pay.credentialJson.payload = { type: 'transaction', signature: '0x76c0' };
      pay.error = value;
    }),
  },
  {
    name: 'payment failure before the credential',
    untraced: false,
    values: hostileErrors,
    scenario: paying((pay, value) => {
      pay.earlyError = value;
    }),
  },
  // The receipt of the settlement, which the reader returns for the check of ADR 0029.
  ...['status', 'logs', 'transactionHash'].map(
    (field): Row => ({
      name: `settlement receipt ${field}`,
      untraced: false,
      scenario: paying(
        () => {},
        (value) => ({ [field]: value }),
      ),
    }),
  ),
  {
    name: 'settlement receipt log',
    untraced: false,
    scenario: paying(
      () => {},
      (value) => ({ logs: [value, ...settlementLogs()] }),
    ),
  },
  // What the caller passes in: only rule 1 applies.
  ...(
    ['reader', 'tracker', 'confirmTimeoutMs', 'decodeRevertReason', 'observeFailures'] as const
  ).map(
    (key): Row => ({
      name: `options.${key}`,
      untraced: false,
      rules: ['same'],
      options: (value) => ({ [key]: value }),
      scenario: paying(() => {}),
    }),
  ),
  {
    name: 'options.reader returning',
    untraced: false,
    rules: ['same'],
    options: (value) => ({ reader: () => value as never }),
    scenario: paying(() => {}),
  },
];

describe('hostile input', () => {
  describeAdapterRows(ROWS, {
    instrument: (options) => options as WithHashspanMppOptions,
    flush: async () => true,
    values: () =>
      hostileValues().filter(
        ([label]) =>
          !/^a hash: (one byte|leading|trailing)|^the name (valueOf|hasOwnProperty)/.test(label),
      ),
    modes: [{}, { address: 'off', errorMessages: 'sanitized' }],
    tracing: () => tracing,
    meters,
  });
});

/** Emits one settled payment whose input is `input`, and returns the recorded `mpp.resource`. */
async function resource(input: string, paymentResource: 'origin' | 'path' = 'path') {
  tracing.reset();
  await paying((pay) => {
    pay.input = input;
  })(undefined, { paymentResource, reader: undefined }).call();
  return tracing.spans()[0]?.attributes['mpp.resource'] as string | undefined;
}

describe('bounds', () => {
  it('keeps at most 512 characters of the resource, dropping an address the cut would split', async () => {
    for (const before of [2, 10, 30, 41]) {
      const recorded = await resource(
        addressAcrossCut(BOUNDS.mppResource, 'https://api.example.com/', before),
      );
      expect(recorded?.length).toBeLessThanOrEqual(BOUNDS.mppResource + 3);
      expect(splitsHex(recorded ?? '')).toBe(false);
    }
  });

  it('records only the origin by default, never a credential in the URL', async () => {
    const recorded = await resource(
      `https://user:${SECRET}@api.example.com/${ADDRESS}?key=${SECRET}#${SECRET}`,
      'origin',
    );
    expect(recorded).toBe('https://api.example.com');
  });

  it(`ends the oldest open payment once ${BOUNDS.openMppPayments} are open`, async () => {
    tracing.reset();
    const fake = fakeClient();
    withHashspan(fake.client);
    for (let i = 0; i <= BOUNDS.openMppPayments; i++) {
      const challenge = challengeOf({ id: `payment-${i}` });
      await fake.emit('challenge.received', { challenge });
      await fake.emit('credential.created', {
        challenge,
        credential: encoded(
          { challenge, payload: { type: 'hash', hash: RECEIPT_HASH } },
          'Payment ',
        ),
      });
    }
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.open()).toBe(BOUNDS.openMppPayments);
  });

  it(`records a challenge id of at most ${BOUNDS.mppChallengeId} characters`, async () => {
    tracing.reset();
    for (const id of ['a'.repeat(BOUNDS.mppChallengeId), 'a'.repeat(BOUNDS.mppChallengeId + 1)]) {
      await paying((pay) => {
        pay.challenge.id = id;
      })(undefined, { reader: undefined }).call();
    }
    expect(tracing.spans().map((span) => span.attributes['mpp.challenge.id'])).toEqual([
      'a'.repeat(BOUNDS.mppChallengeId),
      undefined,
    ]);
  });
});

describe('the client withHashspan() gets', () => {
  it('never throws for a client it cannot register observers on', () => {
    const problems: string[] = [];
    for (const [label, client] of [
      ...hostileValues(),
      [
        'a client whose on() throws',
        {
          on: () => {
            throw new Error('no');
          },
        },
      ],
      ['a throwing Proxy around a client', throwingProxy(fakeClient().client)],
      ['a revoked Proxy', revokedProxy()],
      ['a frozen client', Object.freeze(fakeClient().client)],
    ] as [string, unknown][]) {
      try {
        withHashspan(client as never);
      } catch (error) {
        problems.push(`${label}: ${String(error)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the options withHashspan() gets', () => {
  it('never throws, and registers its observers, for options it cannot read', () => {
    const problems: string[] = [];
    for (const [label, options] of [
      ['null', null],
      ['an object whose option getters throw', throwingGetters(['reader', 'tracker', 'address'])],
      ...hostileValues(),
    ] as [string, unknown][]) {
      const fake = fakeClient();
      try {
        withHashspan(fake.client, options as never);
        if (fake.handlers.size < 3) problems.push(`${label}: no observers registered`);
      } catch (error) {
        problems.push(`${label}: ${String(error)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the observers withHashspan() registers', () => {
  it('never throw, also for a payload that throws an error whose name is not text', async () => {
    const symbolNamed = (): Error => {
      const error = new Error('boom');
      Object.defineProperty(error, 'name', { value: Symbol('name') });
      return error;
    };
    const payload = () =>
      new Proxy(
        {},
        {
          get: () => {
            throw symbolNamed();
          },
          getOwnPropertyDescriptor: () => {
            throw symbolNamed();
          },
          ownKeys: () => {
            throw symbolNamed();
          },
          has: () => {
            throw symbolNamed();
          },
        },
      );
    const fake = fakeClient();
    withHashspan(fake.client, { observeFailures: true });
    const problems: string[] = [];
    for (const [name, handlers] of fake.handlers) {
      for (const handler of handlers) {
        try {
          if ((await handler(payload())) !== undefined) problems.push(`${name}: returned a value`);
        } catch (error) {
          problems.push(`${name}: ${error instanceof Error ? error.message : 'threw'}`);
        }
      }
    }
    expect(fake.handlers.size).toBe(4);
    expect(problems).toEqual([]);
  });
});
