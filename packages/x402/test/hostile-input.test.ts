// ADR 0025: the hooks `withHashspan(client, { reader })` registers on an x402 client, with the hostile-input table of
// `core/test/hostile.ts` applied to what the paid server and the settling party send (payment requirements, the
// settlement response, the receipt the reader returns), to the payer's own payload, and to the reader, tracker and
// client passed in. A hook has no untraced counterpart: it must return nothing and never throw, and what it records
// must keep the rules. A rule that does not hold yet is marked `it.fails` with `// finding: <tag>`.
import { createPublicClient, encodeEventTopics, type Hex, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';
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
  throwingProxy,
} from '../../core/test/hostile.js';
import { mockTransport, HASH as RECEIPT_HASH } from '../../viem/test/mock-transport.js';
import { type WithHashspanX402Options, withHashspan } from '../src/index.js';
import { ASSET, PAY_TO, PAYER, paymentRequired } from './fake-x402.js';

let tracing: HostileTracing;
const meters = recordingMeterProvider();
beforeAll(() => {
  tracing = setupHostileTracing();
});
afterAll(async () => {
  await tracing.teardown();
});

const NONCE = `0x${'5a'.repeat(32)}` as Hex;
const events = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
/** The logs of the default payment's settlement, as a node returns them. */
const settlementLogs = () =>
  [
    encodeEventTopics({
      abi: events,
      eventName: 'AuthorizationUsed',
      args: { authorizer: PAYER as Hex, nonce: NONCE },
    }),
    encodeEventTopics({
      abi: events,
      eventName: 'Transfer',
      args: { from: PAYER as Hex, to: PAY_TO as Hex },
    }),
  ].map((topics, index) => ({
    address: ASSET,
    topics,
    data: index === 0 ? '0x' : `0x${(10_000).toString(16).padStart(64, '0')}`,
    blockNumber: '0x7b',
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionHash: RECEIPT_HASH,
    transactionIndex: '0x0',
    logIndex: `0x${index}`,
    removed: false,
  }));
const readerWith = (receipt: Record<string, unknown> = {}) =>
  createPublicClient({
    chain: baseSepolia,
    transport: mockTransport({
      chainIdHex: '0x14a34',
      receipt: { logs: settlementLogs(), ...receipt },
    }).transport,
    pollingInterval: 10,
  });

type Hook = (ctx: unknown) => unknown;

/** A stand-in for an x402Client that keeps the hooks registered on it. */
function capturingClient() {
  const hooks: Record<string, Hook> = {};
  const register = (name: string) =>
    function (this: unknown, hook: Hook) {
      hooks[name] = hook;
      return this;
    };
  return {
    hooks,
    client: {
      onBeforePaymentCreation: register('before'),
      onAfterPaymentCreation: register('after'),
      onPaymentCreationFailure: register('failure'),
      onPaymentResponse: register('response'),
    },
  };
}

/** One payment's hook contexts, each of which a row can make hostile. */
interface Payment {
  paymentRequired: unknown;
  requirements: unknown;
  payload: unknown;
  settleResponse: unknown;
  /** Set to make the payment fail with this error instead of getting a response. */
  error?: unknown;
}

function payment(): Payment {
  const required = paymentRequired();
  return {
    paymentRequired: required,
    requirements: required.accepts[0],
    payload: { x402Version: 2, payload: { authorization: { from: PAYER, nonce: NONCE } } },
    settleResponse: {
      success: true,
      transaction: RECEIPT_HASH,
      network: 'eip155:84532',
      payer: PAYER,
    },
  };
}

type Row = AdapterRow<WithHashspanX402Options>;

/** Runs `pay` (after `change` made it hostile) through the hooks of a traced client; a hook that returns or throws fails it. */
const paying =
  (
    change: (pay: Payment, value: unknown) => void,
    readerReceipt?: (value: unknown) => Record<string, unknown>,
  ) =>
  (value: unknown, options: WithHashspanX402Options | undefined): AdapterScenario => {
    const { client, hooks } = capturingClient();
    // Made in the call, so that a setup that throws counts as the call throwing.
    let hashspan: ReturnType<typeof withHashspan> | undefined;
    return {
      call: () => {
        hashspan = withHashspan(client, {
          reader: readerWith(readerReceipt?.(value)),
          confirmTimeoutMs: 2_000,
          ...options,
        });
        const pay = payment();
        change(pay, value);
        const run = (name: string, ctx: unknown) => {
          const returned = hooks[name]?.(ctx);
          if (returned !== undefined) throw new TypeError(`the ${name} hook returned a value`);
        };
        run('before', {
          paymentRequired: pay.paymentRequired,
          selectedRequirements: pay.requirements,
        });
        if ('error' in pay) {
          run('failure', {
            paymentRequired: pay.paymentRequired,
            selectedRequirements: pay.requirements,
            error: pay.error,
          });
          return;
        }
        run('after', {
          paymentRequired: pay.paymentRequired,
          selectedRequirements: pay.requirements,
          paymentPayload: pay.payload,
        });
        run('response', {
          paymentPayload: pay.payload,
          requirements: pay.requirements,
          settleResponse: pay.settleResponse,
        });
      },
      flush: async () => (hashspan ? hashspan.flush({ timeoutMs: 3_000 }) : true),
    };
  };

/** A row for each field of the object `of(pay)` returns. */
function fieldRows(
  name: string,
  of: (pay: Payment) => Record<string, unknown>,
  findings: Record<string, Row['findings']> = {},
): Row[] {
  return [
    ...Object.keys(of(payment())).map(
      (key): Row => ({
        name: `${name} ${key}`,
        untraced: false,
        scenario: paying((pay, value) => {
          of(pay)[key] = value;
        }),
        ...(findings[key] ? { findings: findings[key] } : {}),
      }),
    ),
  ];
}

const HOOK_CONTEXTS: (keyof Payment)[] = [
  'paymentRequired',
  'requirements',
  'payload',
  'settleResponse',
];

const ROWS: Row[] = [
  // Each context the hooks get, whole.
  ...HOOK_CONTEXTS.map(
    (key): Row => ({
      name: `hook context ${key}`,
      untraced: false,
      scenario: paying((pay, value) => {
        pay[key] = value;
      }),
    }),
  ),
  // What the paid server asks for.
  ...fieldRows('payment requirements', (pay) => pay.requirements as Record<string, unknown>),
  ...fieldRows('payment required', (pay) => pay.paymentRequired as Record<string, unknown>),
  ...fieldRows(
    'payment required resource',
    (pay) => (pay.paymentRequired as { resource: Record<string, unknown> }).resource,
  ),
  // The payer's payload, as its scheme built it.
  ...fieldRows(
    'payment payload',
    (pay) => (pay.payload as { payload: Record<string, unknown> }).payload,
  ),
  ...fieldRows(
    'payment authorization',
    (pay) =>
      (pay.payload as { payload: { authorization: Record<string, unknown> } }).payload
        .authorization,
  ),
  // What the settling party answers.
  ...fieldRows('settlement response', (pay) => pay.settleResponse as Record<string, unknown>),
  {
    name: 'payment creation failure',
    untraced: false,
    values: hostileErrors,
    scenario: paying((pay, value) => {
      pay.error = value;
    }),
  },
  // The receipt of the settlement, which the reader returns for the check of ADR 0017.
  ...['status', 'logs', 'to', 'from', 'transactionHash'].map(
    (field): Row => ({
      name: `settlement receipt ${field}`,
      untraced: false,
      scenario: paying(
        () => {},
        (value) => ({ [field]: value }),
      ),
    }),
  ),
  // What the caller passes in: only rule 1 applies.
  ...(['reader', 'tracker', 'confirmTimeoutMs', 'decodeRevertReason'] as const).map(
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
    instrument: (options) => options as WithHashspanX402Options,
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

describe('bounds', () => {
  const resource = (url: string, paymentResource: 'origin' | 'path' = 'path') => {
    tracing.reset();
    const { client, hooks } = capturingClient();
    withHashspan(client, { paymentResource });
    const pay = payment();
    (pay.paymentRequired as { resource: { url: string } }).resource.url = url;
    hooks.before?.({
      paymentRequired: pay.paymentRequired,
      selectedRequirements: pay.requirements,
    });
    hooks.after?.({
      paymentRequired: pay.paymentRequired,
      selectedRequirements: pay.requirements,
      paymentPayload: pay.payload,
    });
    hooks.response?.({ paymentPayload: pay.payload, settleResponse: pay.settleResponse });
    return tracing.spans()[0]?.attributes['x402.resource'] as string | undefined;
  };

  it('keeps at most 512 characters of the resource, dropping an address the cut would split', () => {
    for (const before of [2, 10, 30, 41]) {
      const recorded = resource(
        addressAcrossCut(BOUNDS.x402Resource, 'https://api.example.com/', before),
      );
      expect(recorded?.length).toBeLessThanOrEqual(BOUNDS.x402Resource + 3);
      expect(splitsHex(recorded ?? '')).toBe(false);
    }
  });

  it('records only the origin by default, never a credential in the URL', () => {
    const recorded = resource(
      `https://user:${SECRET}@api.example.com/${ADDRESS}?key=${SECRET}#${SECRET}`,
      'origin',
    );
    expect(recorded).toBe('https://api.example.com');
  });

  it(`ends the oldest open payment once ${BOUNDS.openX402Payments} are open`, () => {
    tracing.reset();
    const { client, hooks } = capturingClient();
    withHashspan(client);
    for (let i = 0; i <= BOUNDS.openX402Payments; i++) {
      const pay = payment();
      hooks.before?.({
        paymentRequired: pay.paymentRequired,
        selectedRequirements: pay.requirements,
      });
      hooks.after?.({
        paymentRequired: pay.paymentRequired,
        selectedRequirements: pay.requirements,
        paymentPayload: pay.payload,
      });
    }
    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.open()).toBe(BOUNDS.openX402Payments);
  });
});

describe('the client withHashspan() gets', () => {
  it('never throws for a client it cannot register hooks on', () => {
    const problems: string[] = [];
    for (const [label, client] of [
      ...hostileValues(),
      [
        'a client whose hook registration throws',
        {
          ...capturingClient().client,
          onPaymentResponse: () => {
            throw new Error('no');
          },
        },
      ],
      ['a throwing Proxy around a client', throwingProxy(capturingClient().client)],
      ['a revoked Proxy', revokedProxy()],
      ['a frozen client', Object.freeze(capturingClient().client)],
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
