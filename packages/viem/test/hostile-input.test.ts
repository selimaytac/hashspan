// ADR 0025: the viem adapter's public entry points with the hostile-input table of `core/test/hostile.ts`, applied
// to the caller's arguments, to answers of the node, wallet and bundler (through the mock transports), to a tracker
// passed in, and to the options. Each value runs untraced and traced: the traced call must have the same outcome and
// run no more getters of the caller's; the spans and metrics it records must keep the rules. A rule that does not hold
// yet is marked `it.fails` with `// finding: <tag>`.
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  parseAbi,
  serializeTransaction,
  type Transport,
} from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { base, baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESS,
  type AdapterRow,
  type AdapterRule,
  type AdapterScenario,
  addressAcrossCut,
  BOUNDS,
  countingGetters,
  describeAdapterRows,
  HostileError,
  type HostileTracing,
  hostileErrors,
  hostileValues,
  long,
  outcomeOf,
  recordingMeterProvider,
  revokedProxy,
  setupHostileTracing,
  signature,
  spanProblems,
  splitsHex,
  throwingGetters,
  throwingProxy,
} from '../../core/test/hostile.js';
import { type HashspanExtension, traceTransport, withHashspan } from '../src/index.js';
import {
  GAS,
  type MockBundlerOptions,
  mockBundler,
  stubAccount,
  USER_OP_HASH,
} from './mock-bundler.js';
import { FROM, HASH, type MockOptions, mockTransport, TO } from './mock-transport.js';
import { viemHasAction } from './viem-version.js';

let tracing: HostileTracing;
const meters = recordingMeterProvider();
beforeAll(() => {
  tracing = setupHostileTracing();
});
afterAll(async () => {
  await tracing.teardown();
});

const erc20 = parseAbi([
  'function transfer(address to, uint256 amount)',
  'error Blocked(string why)',
]);
const BATCH_ID = '0xb47c4';
/**
 * The timeout of every wait the table makes: a hostile value often makes viem poll until it, once per run of each
 * value, so it is short; the mocks answer at once.
 */
const WAIT_MS = 100;
/** viem retries a failed request three times with a growing delay; the outcome is the same without, sooner. */
const NO_RETRY = { retryCount: 0 } as const;
/** Requests that carry what the call sends: the traced call must send exactly what the untraced one sends. */
const SENDING = new Set(['eth_sendTransaction', 'wallet_sendCalls', 'eth_sendUserOperation']);

/** The values tried for each input: the hostile table, without the duplicates that only matter to the core. */
const values = (): [string, unknown][] =>
  hostileValues().filter(
    ([label]) =>
      !/^a hash: (one byte|leading|trailing)|^the name (valueOf|hasOwnProperty)/.test(label),
  );

/** A transport answering `overrides` itself and everything else through `transport`. */
function overriding(transport: Transport, overrides: Record<string, () => unknown>): Transport {
  return ((params: Parameters<Transport>[0]) => {
    const created = transport(params);
    return {
      ...created,
      request: async (args: { method: string }) =>
        Object.hasOwn(overrides, args.method)
          ? (overrides[args.method] as () => unknown)()
          : created.request(args as never),
    };
  }) as unknown as Transport;
}

// --- Scenarios: a client, untraced or extended with `hashspan`, and the call the row makes ------------------------

type Scenario = AdapterScenario;

type Extend = HashspanExtension | undefined;

function wallet(hashspan: Extend, node: MockOptions = {}, transport?: (t: Transport) => Transport) {
  const mock = mockTransport({ ...NO_RETRY, ...node });
  const client = createWalletClient({
    account: FROM,
    chain: base,
    transport: transport ? transport(mock.transport) : mock.transport,
    pollingInterval: 10,
  });
  return { client: hashspan ? client.extend(hashspan) : client, mock };
}

function reader(hashspan: Extend, node: MockOptions = {}) {
  const mock = mockTransport({ ...NO_RETRY, ...node });
  const client = createPublicClient({
    chain: base,
    transport: mock.transport,
    pollingInterval: 10,
  });
  return { client: hashspan ? client.extend(hashspan) : client, mock };
}

async function bundler(
  hashspan: Extend,
  node: MockBundlerOptions = {},
  transport?: (t: Transport) => Transport,
) {
  const mock = mockBundler(node);
  const account = await stubAccount(mock.transport);
  const client = createBundlerClient({
    account,
    chain: baseSepolia,
    transport: transport ? transport(mock.transport) : mock.transport,
    pollingInterval: 10,
  });
  return {
    client: hashspan ? client.extend(hashspan) : client,
    requests: () => mock.calls.map((method) => ({ method })),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: actions are called with hostile arguments on purpose.
type AnyClient = any;

/** A scenario calling `action` of a wallet client with `args`. */
const onWallet =
  (action: string, node: MockOptions = {}) =>
  (args: unknown, hashspan: Extend): Scenario => {
    const { client, mock } = wallet(hashspan, node);
    return { call: () => (client as AnyClient)[action](args), requests: () => mock.requests };
  };
const onReader =
  (action: string, node: MockOptions = {}) =>
  (args: unknown, hashspan: Extend): Scenario => {
    const { client, mock } = reader(hashspan, node);
    return { call: () => (client as AnyClient)[action](args), requests: () => mock.requests };
  };
const onBundler =
  (action: string, node: MockBundlerOptions = {}) =>
  async (args: unknown, hashspan: Extend): Promise<Scenario> => {
    const { client, requests } = await bundler(hashspan, node);
    return { call: () => (client as AnyClient)[action](args), requests };
  };

// --- The table -----------------------------------------------------------------------------------------------------

type Rule = AdapterRule;
type Row = AdapterRow<HashspanExtension>;

/** Rows for each field of `base`, an argument object of `action`. */
function argumentRows(
  name: string,
  base: Record<string, unknown>,
  scenario: (args: unknown, hashspan: Extend) => Scenario | Promise<Scenario>,
  findings: Record<string, Partial<Record<Rule, string>>> = {},
  /** The fields telemetry reads; default: all of `base`. */
  keys: readonly string[] = Object.keys(base),
  /** Whether to try the whole argument object as well; off where viem then asks the bundler for estimates. */
  whole = true,
): Row[] {
  const argsOf = (key: string | undefined, value: unknown, getters: boolean): unknown => {
    if (key === undefined) return value;
    const args = { ...base, [key]: value };
    return getters ? countingGetters(args) : args;
  };
  return [
    ...keys.map(
      (key): Row => ({
        name: `${name} ${key}`,
        args: true,
        scenario: async (value, hashspan, getters) => {
          const args = argsOf(key, value, getters);
          const made = await scenario(
            getters ? (args as { value: unknown }).value : args,
            hashspan,
          );
          return getters ? { ...made, reads: (args as { reads(): number }).reads } : made;
        },
        ...(findings[key] ? { findings: findings[key] } : {}),
      }),
    ),
    ...(whole
      ? [
          {
            name: `${name} arguments`,
            scenario: (value: unknown, hashspan: Extend) => scenario(value, hashspan),
            ...(findings[''] ? { findings: findings[''] } : {}),
          },
        ]
      : []),
  ];
}

/** Rows for answers of the node: `node(value)` gives the mock's options for each field of `fields`. */
function answerRows(
  name: string,
  fields: readonly string[],
  scenario: (value: unknown, field: string, hashspan: Extend) => Scenario | Promise<Scenario>,
  findings: Record<string, Partial<Record<Rule, string>>> = {},
): Row[] {
  return fields.map(
    (field): Row => ({
      name: `${name} ${field}`,
      scenario: (value, hashspan) => scenario(value, field, hashspan),
      ...(findings[field] ? { findings: findings[field] } : {}),
    }),
  );
}

const SEND_TRANSACTION = { to: TO, value: 1n, data: '0xa9059cbb', nonce: 1, chain: base };
const WRITE_CONTRACT = { address: TO, abi: erc20, functionName: 'transfer', args: [TO, 1n] };
const WAIT = { hash: HASH, chain: base, onReplaced: () => {}, timeout: WAIT_MS };
const CALLS = { calls: [{ to: TO, value: 1n }], chain: base };
// A transaction viem parses; the mock node never checks a signature.
const RAW = {
  serializedTransaction: serializeTransaction({
    chainId: base.id,
    to: TO,
    value: 1n,
    data: '0xa9059cbb',
    gas: 21_000n,
    nonce: 1,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  }),
};
// sendRawTransactionSync came with viem 2.38.0.
const RAW_SYNC = viemHasAction('sendRawTransactionSync');
// sendTransactionSync and writeContractSync came with viem 2.38.0.
const SYNC = viemHasAction('sendTransactionSync') && viemHasAction('writeContractSync');

/** Rows for the sync actions, which send and return the receipt in one call; none on a viem without them. */
const syncRows = (): Row[] =>
  SYNC
    ? [
        ...argumentRows(
          'sendTransactionSync',
          { ...SEND_TRANSACTION, timeout: WAIT_MS },
          onWallet('sendTransactionSync'),
          {},
          Object.keys(SEND_TRANSACTION),
        ),
        ...argumentRows(
          'writeContractSync',
          { ...WRITE_CONTRACT, timeout: WAIT_MS },
          onWallet('writeContractSync'),
          {},
          Object.keys(WRITE_CONTRACT),
        ),
        ...answerRows(
          'node receipt of sendTransactionSync',
          ['status', 'blockNumber', 'gasUsed', 'effectiveGasPrice', 'transactionHash'],
          (value, field, hashspan) =>
            onWallet('sendTransactionSync', { receipt: { [field]: value } })(
              { to: TO, value: 1n, timeout: WAIT_MS },
              hashspan,
            ),
        ),
        {
          name: 'sendTransactionSync rejected with',
          values: hostileErrors,
          scenario: (value, hashspan) => {
            const { client, mock } = wallet(hashspan, {}, (t) =>
              overriding(t, {
                eth_sendTransaction: () => {
                  throw value;
                },
              }),
            );
            return {
              call: () => (client as AnyClient).sendTransactionSync({ to: TO, value: 1n }),
              requests: () => mock.requests,
            };
          },
        },
      ]
    : [];

const ROWS: Row[] = [
  // The caller's arguments.
  ...argumentRows('sendTransaction', SEND_TRANSACTION, onWallet('sendTransaction')),
  ...argumentRows('sendTransaction', { authorizationList: [] }, onWallet('sendTransaction')),
  {
    name: 'sendTransaction chain.id',
    scenario: (value, hashspan) =>
      onWallet('sendTransaction')({ ...SEND_TRANSACTION, chain: { ...base, id: value } }, hashspan),
  },
  {
    name: 'waitForTransactionReceipt chain.id',
    scenario: (value, hashspan) =>
      onReader('waitForTransactionReceipt')({ ...WAIT, chain: { ...base, id: value } }, hashspan),
  },
  {
    name: 'sendCalls chain.id',
    scenario: (value, hashspan) =>
      onWallet('sendCalls')({ ...CALLS, chain: { ...base, id: value } }, hashspan),
  },
  ...argumentRows('writeContract', WRITE_CONTRACT, onWallet('writeContract')),
  ...syncRows(),
  ...argumentRows('sendRawTransaction', RAW, onWallet('sendRawTransaction')),
  ...(RAW_SYNC
    ? argumentRows(
        'sendRawTransactionSync',
        { ...RAW, timeout: WAIT_MS },
        onWallet('sendRawTransactionSync'),
        {},
        Object.keys(RAW),
      )
    : []),
  ...argumentRows('waitForTransactionReceipt', WAIT, onReader('waitForTransactionReceipt')),
  // Gas fields are left valid: they are not telemetry's, and without them viem asks the bundler for an estimate.
  ...argumentRows(
    'sendUserOperation',
    { calls: [{ to: TO, value: 1n }], entryPointAddress: undefined, sender: undefined, ...GAS },
    onBundler('sendUserOperation'),
    {},
    ['calls', 'entryPointAddress', 'sender'],
    false,
  ),
  ...argumentRows(
    'waitForUserOperationReceipt',
    { hash: USER_OP_HASH, timeout: WAIT_MS },
    onBundler('waitForUserOperationReceipt'),
  ),
  ...argumentRows('sendCalls', CALLS, onWallet('sendCalls')),
  ...argumentRows(
    'waitForCallsStatus',
    { id: BATCH_ID, chain: base, timeout: WAIT_MS },
    onWallet('waitForCallsStatus'),
    {},
    ['id', 'chain', 'timeout'],
    // Without an id, viem polls until its timeout for each value.
    false,
  ).map(
    (row): Row =>
      row.name === 'waitForCallsStatus id'
        ? {
            ...row,
            // viem itself, traced or not, puts the id into the message of its timeout error inside a timer: for an id
            // that cannot be turned into a string, that throws out of the timer and the call never settles.
            values: () =>
              values().filter(
                ([label]) =>
                  label !== 'a symbol' && label !== 'an object with Object.prototype keys',
              ),
          }
        : row,
  ),
  {
    name: 'waitForCallsStatus chain.id',
    scenario: (value, hashspan) =>
      onWallet('waitForCallsStatus')(
        { id: BATCH_ID, timeout: WAIT_MS, chain: { ...base, id: value } },
        hashspan,
      ),
  },

  // Answers of the node, the wallet and the bundler.
  {
    name: 'node answer to eth_sendTransaction',
    scenario: (value, hashspan) => {
      const { client, mock } = wallet(hashspan, {}, (t) =>
        overriding(t, { eth_sendTransaction: () => value }),
      );
      return {
        call: () => client.sendTransaction({ to: TO, value: 1n }),
        requests: () => mock.requests,
      };
    },
  },
  ...answerRows(
    'node receipt',
    [
      'status',
      'blockNumber',
      'gasUsed',
      'effectiveGasPrice',
      'l1Fee',
      'operatorFeeScalar',
      'operatorFeeConstant',
      'transactionHash',
      'blockHash',
      'logs',
    ],
    (value, field, hashspan) =>
      onReader(
        'waitForTransactionReceipt',
        // A block hash that is null or zeros marks a preconfirmed receipt, after which telemetry reads the sealed one
        // (ADR 0024): only the first receipt carries the value, so the sealed one comes at once.
        field === 'blockHash'
          ? { receiptAt: (call) => (call === 1 ? { blockHash: value } : {}) }
          : { receipt: { [field]: value } },
      )(WAIT, hashspan),
  ),
  {
    name: 'node answer to eth_chainId',
    scenario: (value, hashspan) => {
      const mock = mockTransport({ ...NO_RETRY, chainId: () => value as string });
      const client = createWalletClient({ account: FROM, transport: mock.transport });
      const traced = hashspan ? client.extend(hashspan) : client;
      return {
        call: () => traced.sendTransaction({ to: TO, value: 1n } as never),
        requests: () => mock.requests,
      };
    },
  },
  {
    // A receipt that charges an OP Stack operator fee, whose GasPriceOracle call answers with the value.
    name: 'node answer to getOperatorFee',
    scenario: (value, hashspan) =>
      onReader('waitForTransactionReceipt', {
        receipt: { operatorFeeScalar: '0x3e8' },
        operatorFee: () => value,
      })(WAIT, hashspan),
  },
  {
    name: 'node revert data',
    scenario: (value, hashspan) =>
      onReader('waitForTransactionReceipt', {
        receipt: { status: '0x0' },
        callRevertData: value as string,
      })(WAIT, hashspan),
  },
  {
    name: 'wallet answer to wallet_sendCalls',
    scenario: (value, hashspan) => {
      const { client, mock } = wallet(hashspan, {}, (t) =>
        overriding(t, { wallet_sendCalls: () => value }),
      );
      return { call: () => client.sendCalls(CALLS as never), requests: () => mock.requests };
    },
  },
  ...answerRows(
    'wallet call batch status',
    ['status', 'receipts', 'atomic', 'chainId', 'id'],
    (value, field, hashspan) =>
      onWallet('waitForCallsStatus', { callsStatus: () => ({ [field]: value }) })(
        { id: BATCH_ID, chain: base, timeout: WAIT_MS },
        hashspan,
      ),
  ),
  {
    name: 'bundler answer to eth_sendUserOperation',
    scenario: async (value, hashspan) => {
      const { client, requests } = await bundler(hashspan, {}, (t) =>
        overriding(t, { eth_sendUserOperation: () => value }),
      );
      return {
        call: () =>
          (client as AnyClient).sendUserOperation({ calls: [{ to: TO, value: 1n }], ...GAS }),
        requests,
      };
    },
  },
  ...answerRows(
    'bundler user operation receipt',
    [
      'success',
      'actualGasCost',
      'actualGasUsed',
      'sender',
      'nonce',
      'paymaster',
      'entryPoint',
      'reason',
      'receipt',
    ],
    (value, field, hashspan) =>
      onBundler('waitForUserOperationReceipt', { receipt: { [field]: value } })(
        { hash: USER_OP_HASH, timeout: WAIT_MS },
        hashspan,
      ),
  ),

  // Errors the call rejects with, as the wallet or node reports them.
  {
    name: 'sendTransaction rejected with',
    values: hostileErrors,
    scenario: (value, hashspan) => {
      const { client, mock } = wallet(hashspan, {}, (t) =>
        overriding(t, {
          eth_sendTransaction: () => {
            throw value;
          },
        }),
      );
      return {
        call: () => client.sendTransaction({ to: TO, value: 1n }),
        requests: () => mock.requests,
      };
    },
  },

  {
    name: 'sendRawTransaction rejected with',
    values: hostileErrors,
    scenario: (value, hashspan) => {
      const { client, mock } = wallet(hashspan, {}, (t) =>
        overriding(t, {
          eth_sendRawTransaction: () => {
            throw value;
          },
        }),
      );
      return {
        call: () => (client as AnyClient).sendRawTransaction(RAW),
        requests: () => mock.requests,
      };
    },
  },

  // watch() and flush(): no untraced call to compare with; they must not throw or reject.
  ...['hash', 'chainId', 'timeoutMs', 'abi', 'onReceipt'].map(
    (key): Row => ({
      name: `watch options.${key}`,
      untraced: false,
      scenario: (value, hashspan) => {
        const { client, mock } = reader(undefined);
        return {
          call: () =>
            hashspan?.watch(client, { hash: HASH, timeoutMs: WAIT_MS, [key]: value } as never),
          requests: () => mock.requests,
        };
      },
    }),
  ),
  {
    name: 'watch options',
    untraced: false,
    scenario: (value, hashspan) => {
      const { client, mock } = reader(undefined);
      return { call: () => hashspan?.watch(client, value as never), requests: () => mock.requests };
    },
  },
  {
    name: 'watch client',
    untraced: false,
    scenario: (value, hashspan) => ({
      call: () => hashspan?.watch(value as never, { hash: HASH, timeoutMs: WAIT_MS }),
      requests: () => [],
    }),
  },
  {
    name: 'flush options',
    untraced: false,
    scenario: (value, hashspan) => ({
      call: async () => {
        const flushed = await hashspan?.flush(value as never);
        if (typeof flushed !== 'boolean')
          throw new TypeError(`flush resolved with ${typeof flushed}`);
      },
      requests: () => [],
    }),
  },

  // A tracker passed in: the user's, so only rule 1 applies.
  ...(
    [
      'sendTransaction',
      ...(SYNC ? (['sendTransactionSync'] as const) : []),
      'sendRawTransaction',
      'waitForTransactionReceipt',
      'sendCalls',
      'waitForCallsStatus',
      'sendUserOperation',
      'waitForUserOperationReceipt',
    ] as const
  ).map(
    (action): Row => ({
      name: `options.tracker with ${action}`,
      values: hostileTrackers,
      rules: ['same'],
      options: (value) => ({ tracker: value }),
      scenario: (_value, hashspan) => {
        if (action === 'sendTransaction')
          return onWallet('sendTransaction')({ to: TO, value: 1n }, hashspan);
        if (action === 'sendTransactionSync')
          return onWallet('sendTransactionSync')({ to: TO, value: 1n }, hashspan);
        if (action === 'sendRawTransaction') return onWallet('sendRawTransaction')(RAW, hashspan);
        if (action === 'waitForTransactionReceipt')
          return onReader('waitForTransactionReceipt')(WAIT, hashspan);
        if (action === 'sendCalls') return onWallet('sendCalls')(CALLS, hashspan);
        if (action === 'waitForCallsStatus') {
          return onWallet('waitForCallsStatus')(
            { id: BATCH_ID, chain: base, timeout: WAIT_MS },
            hashspan,
          );
        }
        if (action === 'sendUserOperation') {
          return onBundler('sendUserOperation')(
            { calls: [{ to: TO, value: 1n }], ...GAS },
            hashspan,
          );
        }
        return onBundler('waitForUserOperationReceipt')(
          { hash: USER_OP_HASH, timeout: WAIT_MS },
          hashspan,
        );
      },
    }),
  ),

  // withHashspan() options the adapter reads itself.
  ...(['maxBackgroundConfirmations', 'decodeRevertReason', 'confirm'] as const).map(
    (key): Row => ({
      name: `options.${key}`,
      options: (value) => ({ [key]: value }),
      scenario: (_value, hashspan) => {
        const { client, mock } = wallet(hashspan, { receipt: { status: '0x0' } });
        return {
          // With background confirmation, the reverted receipt's reason is replayed after the call.
          call: () => client.sendTransaction({ to: TO, value: 1n }),
          requests: () => mock.requests.filter((request) => SENDING.has(request.method)),
        };
      },
    }),
  ),
];

/** Trackers a caller can pass: broken, from another version, or returning broken handles. */
function hostileTrackers(): [string, unknown][] {
  const handle = (extra: object = {}) => ({
    end() {},
    fail() {},
    timeout() {},
    link() {},
    ...extra,
  });
  const methods = [
    'startSend',
    'startConfirm',
    'startPayment',
    'startUserOperationSend',
    'startUserOperationConfirm',
    'startCallBatchSend',
    'startCallBatchConfirm',
  ];
  const all = (make: () => unknown) => Object.fromEntries(methods.map((method) => [method, make]));
  return [
    ['a throwing Proxy', throwingProxy()],
    ['a revoked Proxy', revokedProxy()],
    ['null', null],
    ['an empty object', {}],
    [
      'methods that throw',
      all(() => {
        throw new HostileError('tracker');
      }),
    ],
    ['methods returning a throwing Proxy', all(() => throwingProxy())],
    ['methods returning a revoked Proxy', all(() => revokedProxy())],
    ['handles whose methods throw', all(() => throwingProxy(handle()))],
    [
      'handles with a context whose getValue throws',
      all(() =>
        handle({
          context: {
            getValue: () => {
              throw new HostileError('getValue');
            },
          },
        }),
      ),
    ],
    [
      'handles with a throwing Proxy context',
      all(() => handle({ context: throwingProxy({ getValue() {} }) })),
    ],
    [
      'handles with a context getter that throws',
      all(() => {
        const made = handle();
        Object.defineProperty(made, 'context', {
          get: () => {
            throw new HostileError('context');
          },
        });
        return made;
      }),
    ],
  ];
}

// --- Running the table -------------------------------------------------------------------------------------------

describe('hostile input', () => {
  describeAdapterRows(ROWS, {
    instrument: (options) => withHashspan(options as never),
    flush: (hashspan) => hashspan.flush({ timeoutMs: 3_000 }),
    values,
    // The second mode keeps addresses and messages hidden, so rule 6 is checked.
    modes: [{}, { address: 'off', errorMessages: 'sanitized' }],
    tracing: () => tracing,
    meters,
    sending: SENDING,
  });
});

// --- The options object itself (rule 1) ---------------------------------------------------------------------------

describe('withHashspan() options', () => {
  const objects = (): [string, unknown][] => [
    ['null', null],
    ['an object whose option getters throw', throwingGetters(['tracker', 'confirm', 'address'])],
    ...hostileValues(),
  ];
  it.each(objects())('gives a working extension for %s', async (_label, options) => {
    let hashspan: HashspanExtension | undefined;
    expect(() => {
      hashspan = withHashspan(options as never);
    }).not.toThrow();
    const { client } = wallet(hashspan as HashspanExtension);
    await expect(client.sendTransaction({ to: TO, value: 1n })).resolves.toBe(HASH);
    await expect((hashspan as HashspanExtension).flush({ timeoutMs: 3_000 })).resolves.toBe(true);
  });
});

// --- Bounds the adapter applies itself ----------------------------------------------------------------------------

describe('bounds', () => {
  const revertReason = async (why: string) => {
    tracing.reset();
    const hashspan = withHashspan();
    const { client } = reader(hashspan, {
      receipt: { status: '0x0' },
      callRevertData: encodeErrorResult({ abi: erc20, errorName: 'Blocked', args: [why] }),
    });
    await client.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    return tracing.spans()[0]?.attributes['blockchain.tx.revert.reason'];
  };

  it('keeps at most 1024 characters of a revert reason', async () => {
    for (const length of [
      BOUNDS.revertReason - 1,
      BOUNDS.revertReason,
      BOUNDS.revertReason + 1,
      100_000,
    ]) {
      const recorded = await revertReason(long(length));
      expect(typeof recorded).toBe('string');
      expect((recorded as string).length).toBeLessThanOrEqual(BOUNDS.revertReason + 3);
    }
  });

  it('drops an address the revert reason cut would split', async () => {
    for (const before of [2, 10, 30, 41]) {
      // `Blocked(` comes first: the address starts `before` characters before the cut.
      const recorded = await revertReason(addressAcrossCut(BOUNDS.revertReason, '', before + 8));
      expect(splitsHex(recorded as string)).toBe(false);
      expect(recorded).not.toContain(ADDRESS.slice(0, 12));
    }
  });
});

// --- traceTransport() ---------------------------------------------------------------------------------------------

describe('traceTransport', () => {
  /** A transport whose node fails every request with `error`. */
  const failing = (error: () => unknown): Transport =>
    custom({ request: async () => Promise.reject(error()) }, { retryCount: 0 });

  const run = async (transport: (traced: boolean) => Transport, args: () => unknown) => {
    const outcomes: string[] = [];
    for (const traced of [false, true]) {
      const client = createPublicClient({ chain: base, transport: transport(traced) });
      outcomes.push(signature(await outcomeOf(() => client.request(args() as never))));
    }
    return outcomes;
  };

  it.each(values().map(([label]) => [label]))(
    'passes request arguments of %s on as untraced',
    async (label) => {
      const pick = () => values().find(([name]) => name === label)?.[1];
      tracing.reset();
      const [plain, traced] = await run(
        (on) =>
          on
            ? traceTransport(mockTransport(NO_RETRY).transport)
            : mockTransport(NO_RETRY).transport,
        pick,
      );
      expect(traced).toBe(plain);
      expect(tracing.open()).toBe(0);
      expect(spanProblems(tracing.spans())).toEqual([]);
    },
  );

  it('records error.type of a failed request within its bounds', async () => {
    tracing.reset();
    const problems: string[] = [];
    for (const [label, value] of hostileErrors()) {
      const [plain, traced] = await run(
        (on) => (on ? traceTransport(failing(() => value)) : failing(() => value)),
        () => ({ method: 'eth_blockNumber' }),
      );
      if (traced !== plain) problems.push(`${label}: traced ${traced}, untraced ${plain}`);
    }
    problems.push(...spanProblems(tracing.spans()));
    expect(problems).toEqual([]);
  });

  it('passes errors on unchanged and ends every span', async () => {
    tracing.reset();
    for (const [, value] of [...hostileErrors(), ...values()]) {
      const [plain, traced] = await run(
        (on) => (on ? traceTransport(failing(() => value)) : failing(() => value)),
        () => ({ method: 'eth_blockNumber' }),
      );
      expect(traced).toBe(plain);
    }
    expect(tracing.open()).toBe(0);
  });

  it('records error codes, but no other value of an error', async () => {
    tracing.reset();
    for (const code of [-32_000, 2 ** 53 + 1, Number.NaN, 1.5, '4001', 10n]) {
      await run(
        (on) => {
          const error = () => Object.assign(new Error('boom'), { code });
          return on ? traceTransport(failing(error)) : failing(error);
        },
        () => ({ method: 'eth_blockNumber' }),
      );
    }
    for (const span of tracing.spans()) {
      const status = span.attributes['rpc.response.status_code'];
      if (status !== undefined) expect(status).toMatch(/^-?\d{1,16}$/);
    }
  });

  it.each(values().map(([label]) => [label]))(
    'sends the request when the methods option returns %s',
    async (label) => {
      const pick = () => values().find(([name]) => name === label)?.[1];
      tracing.reset();
      const [plain, traced] = await run(
        (on) =>
          on
            ? traceTransport(mockTransport(NO_RETRY).transport, {
                methods: () => pick() as boolean,
              })
            : mockTransport(NO_RETRY).transport,
        () => ({ method: 'eth_blockNumber' }),
      );
      expect(traced).toBe(plain);
    },
  );

  it('sends the request when the methods option throws, or the transport has a hostile URL', async () => {
    tracing.reset();
    const withUrl = (url: unknown): Transport =>
      ((params: Parameters<Transport>[0]) => {
        const created = mockTransport(NO_RETRY).transport(params);
        return { ...created, value: { url } };
      }) as unknown as Transport;
    for (const [, url] of values()) {
      const [plain, traced] = await run(
        (on) => (on ? traceTransport(withUrl(url)) : withUrl(url)),
        () => ({ method: 'eth_blockNumber' }),
      );
      expect(traced).toBe(plain);
    }
    const [plain, traced] = await run(
      (on) =>
        on
          ? traceTransport(mockTransport(NO_RETRY).transport, {
              methods: () => {
                throw new HostileError('methods');
              },
            })
          : mockTransport(NO_RETRY).transport,
      () => ({ method: 'eth_blockNumber' }),
    );
    expect(traced).toBe(plain);
    expect(spanProblems(tracing.spans())).toEqual([]);
  });
});
