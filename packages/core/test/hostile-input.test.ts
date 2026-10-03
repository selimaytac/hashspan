// ADR 0025: every public entry point of the core, with the hostile-input table applied to each untrusted value it
// reads. A row names an entry point and one input; each rule is its own test, so a finding fails one test only.
// A row whose rule does not hold yet is marked `it.fails` with `// finding: <tag>`; fixing it turns that test red
// until the mark is removed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTxTracker, type TxTracker, type TxTrackerOptions } from '../src/index.js';
import {
  ADDRESS,
  addressAcrossCut,
  aroundBound,
  BOUNDS,
  budgeted,
  countingGetters,
  debugProblems,
  dense,
  HASH,
  type HostileTracing,
  hostileErrors,
  hostileValues,
  hugeSparse,
  long,
  MIXED_CASE_ADDRESS,
  MIXED_CASE_HASH,
  metricProblems,
  OTHER_ADDRESS,
  prototypeKeyed,
  type RecordingModes,
  recordingMeterProvider,
  SECRET,
  SECRET_URL,
  setupHostileTracing,
  spanProblems,
  splitsHex,
} from './hostile.js';

const CHAIN_ID = 8453;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const BATCH_ID = '0xb47c4';

let tracing: HostileTracing;
let meters: ReturnType<typeof recordingMeterProvider>;
beforeEach(() => {
  tracing = setupHostileTracing();
  meters = recordingMeterProvider();
});
afterEach(async () => {
  await tracing.teardown();
});

// --- Valid inputs, into which a row puts one hostile value ---------------------------------------------------------

const SEND = {
  chainId: CHAIN_ID,
  from: ADDRESS,
  to: OTHER_ADDRESS,
  value: 1n,
  nonce: 1,
  functionName: 'transfer',
  functionSelector: '0xa9059cbb',
  functionArguments: [ADDRESS, 1n],
  authorizations: [{ address: ADDRESS, chainId: 1 }],
};
const CONFIRM = { chainId: CHAIN_ID, hash: HASH };
const RECEIPT = {
  status: 'success',
  blockNumber: 10n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
  l1Fee: 1n,
  transactionHash: HASH,
};
const PAYMENT = {
  chainId: CHAIN_ID,
  protocol: 'x402',
  payer: ADDRESS,
  recipient: OTHER_ADDRESS,
  asset: OTHER_ADDRESS,
  amount: 10_000n,
  x402: { scheme: 'exact', resource: 'https://api.example.com/weather' },
};
const SETTLEMENT = {
  status: 'settled',
  hash: HASH,
  payer: ADDRESS,
  amount: '10000',
  verified: true,
};
const USER_OPERATION = {
  chainId: CHAIN_ID,
  sender: ADDRESS,
  entryPoint: OTHER_ADDRESS,
  callCount: 2,
};
const USER_OPERATION_CONFIRM = { chainId: CHAIN_ID, userOpHash: HASH };
const USER_OPERATION_RECEIPT = {
  success: false,
  actualGasCost: 5n,
  actualGasUsed: 21_000n,
  sender: ADDRESS,
  nonce: '0x1',
  paymaster: OTHER_ADDRESS,
  entryPoint: OTHER_ADDRESS,
  revertReason: 'Insufficient()',
  transactionHash: OTHER_HASH,
  blockNumber: 10n,
};
const CALL_BATCH = { chainId: CHAIN_ID, sender: ADDRESS, callCount: 2 };
const CALL_BATCH_CONFIRM = { chainId: CHAIN_ID, id: BATCH_ID };
const CALL_BATCH_STATUS = {
  statusCode: 200,
  atomic: true,
  receipts: [{ transactionHash: HASH, blockNumber: 10n }],
};

const at = (base: object, key: string, value: unknown): unknown => ({ ...base, [key]: value });
const error = (): Error => new Error('boom');

/** Uses every entry point once with valid inputs, for rows that make the tracker itself hostile. */
function exercise(tracker: TxTracker): void {
  tracker.startSend(SEND).end({ hash: HASH });
  tracker.startSend(SEND).fail(error());
  tracker.startConfirm(CONFIRM).end(RECEIPT as never);
  tracker.startConfirm({ chainId: CHAIN_ID, hash: OTHER_HASH }).fail(error());
  tracker.startPayment(PAYMENT).end(SETTLEMENT as never);
  tracker.startUserOperationSend(USER_OPERATION).end({ userOpHash: HASH });
  tracker.startUserOperationConfirm(USER_OPERATION_CONFIRM).end(USER_OPERATION_RECEIPT);
  tracker.startCallBatchSend(CALL_BATCH).end({ id: BATCH_ID, transactionHashes: [OTHER_HASH] });
  tracker.startCallBatchConfirm(CALL_BATCH_CONFIRM).end(CALL_BATCH_STATUS);
}

// --- Findings: rules that do not hold yet, one tag per root cause --------------------------------------------------

// finding: core-chain-id. The chain id is recorded unchecked: span attribute, span name and metric label.
const CHAIN_ID_FINDING = { records: 'core-chain-id', metrics: 'core-chain-id' } as const;
// finding: core-send-address. startSend records `from` and `to` without checking that they are addresses.
const SEND_ADDRESS_FINDING = { records: 'core-send-address' } as const;
// finding: core-send-input. startSend records value, nonce, function name and selector unchecked and unbounded.
const SEND_INPUT_FINDING = { records: 'core-send-input' } as const;
// finding: core-tx-hash. SendHandle.end and startConfirm record any string as blockchain.tx.hash.
const TX_HASH_FINDING = { records: 'core-tx-hash' } as const;
// finding: core-receipt-quantities. Receipt block number, gas used, gas price and L1 fee are recorded unchecked.
const RECEIPT_QUANTITY_FINDING = { records: 'core-receipt-quantities' } as const;
// finding: core-revert-reason. The core does not bound revert reasons; only the viem adapter's decoder does.
const REVERT_REASON_FINDING = { records: 'core-revert-reason' } as const;
// finding: core-error-name. error.type and exception.type take an error's name unbounded.
const ERROR_NAME_FINDING = { records: 'core-error-name' } as const;
// finding: core-receipt-open-span. A receipt that cannot be read leaves the confirm span open, never exported.
const OPEN_SPAN_FINDING = { throws: 'core-receipt-open-span' } as const;
// finding: core-handle-throws. CallBatchConfirmHandle.end throws for a status that cannot be read.
const HANDLE_THROWS_FINDING = { throws: 'core-handle-throws' } as const;
// finding: core-options. Options are not checked: createTxTracker(null) throws, and a TTL or bound that is not a
// number makes handle methods throw or leaves spans open.
const OPTIONS_FINDING = { throws: 'core-options' } as const;

// --- The table -----------------------------------------------------------------------------------------------------

type Rule = 'throws' | 'records' | 'metrics';

interface Row {
  /** The entry point and the input the hostile value goes into. */
  name: string;
  /** Uses the entry point with `value` in that input, ending what it starts. */
  run(tracker: TxTracker, value: unknown): void;
  /** The tracker options, for rows about the options themselves; `base` holds the recording mode and meters. */
  options?(value: unknown, base: TxTrackerOptions): TxTrackerOptions;
  /** The values to try; default: every hostile value. */
  values?(): [string, unknown][];
  /** The recording modes `value` leaves in effect, for rows about the options that set them. */
  modes?(value: unknown, modes: RecordingModes): RecordingModes;
  /** Rules that apply; default: all. */
  rules?: readonly Rule[];
  /** Rules that do not hold yet, with the finding's tag. */
  findings?: Partial<Record<Rule, string>>;
}

/** Each row runs under these recording modes, so that rule 6 is checked where data must stay hidden. */
const MODES: readonly (TxTrackerOptions & RecordingModes)[] = [
  {},
  { address: 'off', errorMessages: 'sanitized', recordFunctionArguments: true },
  {
    address: 'hashed',
    errorMessages: 'raw',
    recordFunctionArguments: true,
    paymentResource: 'path',
  },
];

const errors = (): [string, unknown][] => hostileErrors();

/** One row per field of `base`, each running `run` with the field replaced. */
function fields(
  entry: string,
  base: Record<string, unknown>,
  run: (tracker: TxTracker, input: unknown) => void,
  findings: Record<string, Partial<Record<Rule, string>>> = {},
): Row[] {
  return Object.keys(base).map((key) => ({
    name: `${entry} ${key}`,
    run: (tracker, value) => run(tracker, at(base, key, value)),
    ...(findings[key] ? { findings: findings[key] } : {}),
  }));
}

const ROWS: Row[] = [
  // startSend and its handle.
  ...fields('startSend', SEND, (t, input) => t.startSend(input as never).end({ hash: HASH }), {
    chainId: CHAIN_ID_FINDING,
    from: SEND_ADDRESS_FINDING,
    to: SEND_ADDRESS_FINDING,
    value: SEND_INPUT_FINDING,
    nonce: SEND_INPUT_FINDING,
    functionName: SEND_INPUT_FINDING,
    functionSelector: SEND_INPUT_FINDING,
  }),
  {
    name: 'startSend input',
    run: (t, value) => t.startSend(value as never).end({ hash: HASH }),
    findings: { metrics: 'core-chain-id' },
  },
  {
    name: 'startSend startTime',
    run: (t, value) => t.startSend({ ...SEND, startTime: value as never }).end({ hash: HASH }),
  },
  {
    name: 'startSend parent',
    run: (t, value) => t.startSend(SEND, value as never).end({ hash: HASH }),
  },
  {
    name: 'SendHandle.end result',
    run: (t, value) => t.startSend(SEND).end(value as never),
    findings: TX_HASH_FINDING,
  },
  {
    name: 'SendHandle.end result.hash',
    run: (t, value) => t.startSend(SEND).end({ hash: value as never }),
    findings: TX_HASH_FINDING,
  },
  {
    name: 'SendHandle.end options',
    run: (t, value) => t.startSend(SEND).end({ hash: HASH }, value as never),
  },
  {
    name: 'SendHandle.fail error',
    values: errors,
    run: (t, value) => t.startSend(SEND).fail(value),
    findings: ERROR_NAME_FINDING,
  },
  {
    name: 'SendHandle.fail options',
    run: (t, value) => t.startSend(SEND).fail(error(), value as never),
  },
  {
    name: 'SendHandle.fail options.errorType',
    run: (t, value) => t.startSend(SEND).fail(error(), { errorType: value as never }),
  },

  // startConfirm and its handle.
  ...fields(
    'startConfirm',
    CONFIRM,
    (t, input) => t.startConfirm(input as never).end(RECEIPT as never),
    {
      chainId: CHAIN_ID_FINDING,
      hash: TX_HASH_FINDING,
    },
  ),
  {
    name: 'startConfirm input',
    run: (t, value) => t.startConfirm(value as never).end(RECEIPT as never),
  },
  ...fields(
    'ConfirmHandle.end receipt',
    RECEIPT,
    (t, receipt) => t.startConfirm(CONFIRM).end(receipt as never),
    {
      blockNumber: RECEIPT_QUANTITY_FINDING,
      gasUsed: RECEIPT_QUANTITY_FINDING,
      effectiveGasPrice: RECEIPT_QUANTITY_FINDING,
      l1Fee: RECEIPT_QUANTITY_FINDING,
    },
  ),
  {
    name: 'ConfirmHandle.end receipt',
    run: (t, value) => t.startConfirm(CONFIRM).end(value as never),
    findings: OPEN_SPAN_FINDING,
  },
  {
    name: 'ConfirmHandle.end receipt.revertReason',
    run: (t, value) =>
      t.startConfirm(CONFIRM).end({ ...RECEIPT, status: 'reverted', revertReason: value } as never),
    findings: REVERT_REASON_FINDING,
  },
  {
    name: 'ConfirmHandle.end receipt.replacementReason',
    run: (t, value) =>
      t
        .startConfirm(CONFIRM)
        .end({ ...RECEIPT, transactionHash: OTHER_HASH, replacementReason: value } as never),
  },
  {
    name: 'ConfirmHandle.end options',
    run: (t, value) => t.startConfirm(CONFIRM).end(RECEIPT as never, value as never),
  },
  {
    name: 'ConfirmHandle.timeout options',
    run: (t, value) => t.startConfirm(CONFIRM).timeout(value as never),
  },
  {
    name: 'ConfirmHandle.fail error',
    values: errors,
    run: (t, value) => t.startConfirm(CONFIRM).fail(value),
    findings: ERROR_NAME_FINDING,
  },

  // startPayment and its handle.
  ...fields(
    'startPayment',
    PAYMENT,
    (t, input) => t.startPayment(input as never).end(SETTLEMENT as never),
    { chainId: { records: 'core-chain-id' } },
  ),
  {
    name: 'startPayment x402.scheme',
    run: (t, value) =>
      t.startPayment({ ...PAYMENT, x402: { scheme: value as never } }).end(SETTLEMENT as never),
  },
  {
    name: 'startPayment x402.resource',
    run: (t, value) =>
      t.startPayment({ ...PAYMENT, x402: { resource: value as never } }).end(SETTLEMENT as never),
  },
  {
    name: 'startPayment input',
    run: (t, value) => t.startPayment(value as never).end(SETTLEMENT as never),
  },
  ...fields('PaymentHandle.end settlement', SETTLEMENT, (t, settlement) =>
    t.startPayment(PAYMENT).end(settlement as never),
  ),
  {
    name: 'PaymentHandle.end settlement.errorReason',
    run: (t, value) =>
      t.startPayment(PAYMENT).end({ status: 'failed', errorReason: value } as never),
  },
  {
    name: 'PaymentHandle.end settlement',
    run: (t, value) => t.startPayment(PAYMENT).end(value as never),
  },
  {
    name: 'PaymentHandle.fail error',
    values: errors,
    run: (t, value) => t.startPayment(PAYMENT).fail(value),
    findings: ERROR_NAME_FINDING,
  },
  {
    name: 'PaymentHandle.fail options.errorType',
    run: (t, value) => t.startPayment(PAYMENT).fail(undefined, { errorType: value as never }),
  },
  {
    name: 'PaymentHandle.timeout options',
    run: (t, value) => t.startPayment(PAYMENT).timeout(value as never),
  },
  {
    name: 'PaymentHandle.link hash',
    run: (t, value) => {
      const payment = t.startPayment(PAYMENT);
      payment.link(value as never);
      payment.end({ status: 'settled' });
    },
  },

  // User operations.
  ...fields(
    'startUserOperationSend',
    USER_OPERATION,
    (t, input) => t.startUserOperationSend(input as never).end({ userOpHash: HASH }),
    { chainId: CHAIN_ID_FINDING },
  ),
  {
    name: 'startUserOperationSend input',
    run: (t, value) => t.startUserOperationSend(value as never).end({ userOpHash: HASH }),
    findings: { metrics: 'core-chain-id' },
  },
  {
    name: 'UserOperationSendHandle.end result',
    run: (t, value) => t.startUserOperationSend(USER_OPERATION).end(value as never),
  },
  {
    name: 'UserOperationSendHandle.end result.userOpHash',
    run: (t, value) => t.startUserOperationSend(USER_OPERATION).end({ userOpHash: value as never }),
  },
  {
    name: 'UserOperationSendHandle.fail error',
    values: errors,
    run: (t, value) => t.startUserOperationSend(USER_OPERATION).fail(value),
    findings: ERROR_NAME_FINDING,
  },
  ...fields(
    'startUserOperationConfirm',
    USER_OPERATION_CONFIRM,
    (t, input) => t.startUserOperationConfirm(input as never).end(USER_OPERATION_RECEIPT),
    { chainId: CHAIN_ID_FINDING },
  ),
  ...fields(
    'UserOperationConfirmHandle.end receipt',
    USER_OPERATION_RECEIPT,
    (t, receipt) => t.startUserOperationConfirm(USER_OPERATION_CONFIRM).end(receipt as never),
    { revertReason: REVERT_REASON_FINDING },
  ),
  {
    name: 'UserOperationConfirmHandle.end receipt',
    run: (t, value) => t.startUserOperationConfirm(USER_OPERATION_CONFIRM).end(value as never),
  },
  {
    name: 'UserOperationConfirmHandle.timeout options',
    run: (t, value) => t.startUserOperationConfirm(USER_OPERATION_CONFIRM).timeout(value as never),
  },
  {
    name: 'UserOperationConfirmHandle.fail error',
    values: errors,
    run: (t, value) => t.startUserOperationConfirm(USER_OPERATION_CONFIRM).fail(value),
    findings: ERROR_NAME_FINDING,
  },

  // Call batches.
  ...fields(
    'startCallBatchSend',
    CALL_BATCH,
    (t, input) => t.startCallBatchSend(input as never).end({ id: BATCH_ID }),
    { chainId: CHAIN_ID_FINDING },
  ),
  {
    name: 'CallBatchSendHandle.end result',
    run: (t, value) => t.startCallBatchSend(CALL_BATCH).end(value as never),
  },
  {
    name: 'CallBatchSendHandle.end result.id',
    run: (t, value) => t.startCallBatchSend(CALL_BATCH).end({ id: value as never }),
  },
  {
    name: 'CallBatchSendHandle.end result.transactionHashes',
    run: (t, value) => {
      t.startCallBatchSend(CALL_BATCH).end({ id: BATCH_ID, transactionHashes: value as never });
      t.startConfirm(CONFIRM).end(RECEIPT as never);
    },
  },
  {
    name: 'CallBatchSendHandle.fail error',
    values: errors,
    run: (t, value) => t.startCallBatchSend(CALL_BATCH).fail(value),
    findings: ERROR_NAME_FINDING,
  },
  ...fields(
    'startCallBatchConfirm',
    CALL_BATCH_CONFIRM,
    (t, input) => t.startCallBatchConfirm(input as never).end(CALL_BATCH_STATUS),
    { chainId: CHAIN_ID_FINDING },
  ),
  ...fields('CallBatchConfirmHandle.end status', CALL_BATCH_STATUS, (t, status) =>
    t.startCallBatchConfirm(CALL_BATCH_CONFIRM).end(status as never),
  ),
  {
    name: 'CallBatchConfirmHandle.end status.receipts[0].transactionHash',
    run: (t, value) =>
      t
        .startCallBatchConfirm(CALL_BATCH_CONFIRM)
        .end({ statusCode: 200, receipts: [{ transactionHash: value as never }] }),
  },
  {
    name: 'CallBatchConfirmHandle.end status.receipts[0].blockNumber',
    run: (t, value) =>
      t.startCallBatchConfirm(CALL_BATCH_CONFIRM).end({
        statusCode: 200,
        receipts: [{ transactionHash: HASH, blockNumber: value as never }],
      }),
  },
  {
    name: 'CallBatchConfirmHandle.end status',
    run: (t, value) => t.startCallBatchConfirm(CALL_BATCH_CONFIRM).end(value as never),
    findings: HANDLE_THROWS_FINDING,
  },
  {
    name: 'CallBatchConfirmHandle.timeout options',
    run: (t, value) => t.startCallBatchConfirm(CALL_BATCH_CONFIRM).timeout(value as never),
  },
  {
    name: 'CallBatchConfirmHandle.fail error',
    values: errors,
    run: (t, value) => t.startCallBatchConfirm(CALL_BATCH_CONFIRM).fail(value),
    findings: ERROR_NAME_FINDING,
  },

  // createTxTracker() options, each with every entry point used once.
  ...(
    [
      'address',
      'errorMessages',
      'paymentResource',
      'recordFunctionArguments',
      'agent',
      'agentFromBaggage',
      'linkTtlMs',
      'maxTrackedTransactions',
      'tracerProvider',
      'meterProvider',
    ] as const
  ).map(
    (key): Row => ({
      name: `createTxTracker options.${key}`,
      options: (value, base) => ({ ...base, [key]: value }),
      run: exercise,
      // An unknown mode records nothing; undefined is the default.
      ...(key === 'address'
        ? { modes: (value, modes) => ({ ...modes, address: value === undefined ? 'raw' : 'off' }) }
        : key === 'errorMessages'
          ? { modes: (_value, modes) => ({ ...modes, errorMessages: 'off' }) }
          : {}),
      // The agent identity is the user's own text, recorded as given.
      ...(key === 'agent' ? { rules: ['throws', 'metrics'] as const } : {}),
      ...(key === 'linkTtlMs' || key === 'maxTrackedTransactions'
        ? { findings: OPTIONS_FINDING }
        : {}),
    }),
  ),
  {
    // What the hook returns is what the user chose to record: only rules 1 and 5 apply.
    name: 'createTxTracker options.redact returning a hostile value',
    options: (value, base) => ({ ...base, redact: () => value as never }),
    run: exercise,
    rules: ['throws', 'metrics'],
  },
  {
    name: 'createTxTracker options.redact throwing it',
    options: (value, base) => ({
      ...base,
      redact: () => {
        throw value;
      },
    }),
    run: exercise,
  },
  {
    name: 'createTxTracker options',
    options: (value) => value as never,
    modes: () => ({}),
    run: exercise,
    findings: OPTIONS_FINDING,
  },
];

/** Runs `row` with every value under every mode; returns what went wrong, per value. */
function check(row: Row, rule: Rule): string[] {
  const problems: string[] = [];
  for (const modes of MODES) {
    for (const [label, value] of (row.values ?? hostileValues)()) {
      tracing.reset();
      meters.reset();
      const where = `${label} (${modes.address ?? 'raw'} addresses)`;
      let tracker: TxTracker | undefined;
      try {
        const base: TxTrackerOptions = { meterProvider: meters.provider, ...modes };
        tracker = createTxTracker(row.options ? row.options(value, base) : base);
        row.run(tracker, value);
      } catch (thrown) {
        if (rule === 'throws') problems.push(`${where}: threw ${show(thrown)}`);
        continue;
      }
      if (rule === 'throws' && tracing.open() > 0) {
        problems.push(`${where}: left ${tracing.open()} span(s) open`);
      }
      if (rule === 'records') {
        const recorded = row.modes ? row.modes(value, modes) : modes;
        for (const problem of spanProblems(tracing.spans(), recorded)) {
          problems.push(`${where}: ${problem}`);
        }
      }
      if (rule === 'metrics') {
        for (const problem of metricProblems(meters.samples()))
          problems.push(`${where}: ${problem}`);
      }
    }
  }
  return problems;
}

function show(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message.slice(0, 80)}` : String(value);
  } catch {
    return 'an unreadable value';
  }
}

const RULE_NAMES: Record<Rule, string> = {
  throws: 'never throws into the caller and ends every span it starts (rule 1)',
  records: 'records only valid, bounded values, and hidden data stays hidden (rules 3, 4, 6)',
  metrics: 'keeps metric attributes in closed sets (rule 5)',
};

describe('hostile input', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      for (const rule of row.rules ?? (['throws', 'records', 'metrics'] as const)) {
        const finding = row.findings?.[rule];
        // finding: see the tag, listed with a repro in the pull request that added it.
        (finding ? it.fails : it)(
          `${RULE_NAMES[rule]}${finding ? ` [finding: ${finding}]` : ''}`,
          () => {
            const problems = check(row, rule);
            debugProblems(`${row.name} | ${rule}`, problems);
            expect(problems).toEqual([]);
          },
        );
      }
    });
  }
});

// --- Rule 4: each documented bound, one below, at and above it, and with an address across the cut ---------------

const spanAttribute = (key: string): unknown => tracing.spans()[0]?.attributes[key];
const eventAttribute = (key: string): unknown => tracing.spans()[0]?.events[0]?.attributes?.[key];

interface TextBound {
  name: string;
  bound: number;
  /** Records `text` and returns what was recorded. */
  record(text: string): unknown;
  /** Prefix that makes `text` a value of the right kind, such as a URL. */
  prefix?: string;
  findings?: { length?: string; split?: string };
}

const TEXT_BOUNDS: TextBound[] = [
  {
    name: 'exception.message (sanitized)',
    bound: BOUNDS.sanitizedMessage,
    record: (text) => {
      createTxTracker({ errorMessages: 'sanitized' }).startSend(SEND).fail(new Error(text));
      return eventAttribute('exception.message');
    },
    // finding: core-cut-splits-hex. Sanitized messages are cut without regard to a hex value across the cut.
    findings: { split: 'core-cut-splits-hex' },
  },
  {
    name: 'blockchain.contract.function.arguments',
    bound: BOUNDS.functionArguments,
    record: (text) => {
      createTxTracker({ recordFunctionArguments: true })
        .startSend({ ...SEND, functionArguments: [text] })
        .end({ hash: HASH });
      return spanAttribute('blockchain.contract.function.arguments');
    },
    // finding: core-cut-splits-hex. Function arguments are cut without regard to a hex value across the cut.
    findings: { split: 'core-cut-splits-hex' },
  },
  {
    name: 'x402.resource (path)',
    bound: BOUNDS.x402Resource,
    prefix: 'https://api.example.com/',
    record: (text) => {
      createTxTracker({ paymentResource: 'path' })
        .startPayment({ ...PAYMENT, x402: { resource: text } })
        .end(SETTLEMENT as never);
      return spanAttribute('x402.resource');
    },
  },
  {
    name: 'blockchain.tx.revert.reason',
    bound: BOUNDS.revertReason,
    record: (text) => {
      createTxTracker()
        .startConfirm(CONFIRM)
        .end({ ...RECEIPT, status: 'reverted', revertReason: text } as never);
      return spanAttribute('blockchain.tx.revert.reason');
    },
    // finding: core-revert-reason (see above). Nothing is cut, so nothing is split either.
    findings: { length: 'core-revert-reason' },
  },
];

describe('bounds', () => {
  for (const { name, bound, record, prefix = '', findings } of TEXT_BOUNDS) {
    describe(name, () => {
      (findings?.length ? it.fails : it)(
        `keeps at most ${bound} characters${findings?.length ? ` [finding: ${findings.length}]` : ''}`,
        () => {
          for (const [, text] of [...aroundBound(bound), ['long', long()] as const]) {
            tracing.reset();
            const recorded = record(`${prefix}${text.slice(prefix.length)}`);
            expect(typeof recorded).toBe('string');
            expect((recorded as string).length).toBeLessThanOrEqual(bound + 3);
          }
        },
      );
      (findings?.split ? it.fails : it)(
        `drops a hex value the cut would split${findings?.split ? ` [finding: ${findings.split}]` : ''}`,
        () => {
          for (const before of [2, 10, 30, 41]) {
            tracing.reset();
            const recorded = record(addressAcrossCut(bound, prefix, before));
            expect(typeof recorded).toBe('string');
            expect(splitsHex(recorded as string)).toBe(false);
          }
        },
      );
    });
  }

  it('keeps a call batch id to its first 256 characters', () => {
    const id = `0x${'ab'.repeat(4096)}`;
    createTxTracker().startCallBatchSend(CALL_BATCH).end({ id });
    expect(spanAttribute('blockchain.call_batch.id')).toBe(id.slice(0, BOUNDS.callBatchId));
  });

  it('records function arguments nested up to the depth bound, and none deeper', () => {
    const nested = (depth: number): unknown => {
      let value: unknown = 'leaf';
      // The argument list itself is the first level.
      for (let i = 1; i < depth; i++) value = [value];
      return value;
    };
    const recorded = (depth: number) => {
      tracing.reset();
      createTxTracker({ recordFunctionArguments: true })
        .startSend({ ...SEND, functionArguments: [nested(depth)] })
        .end({ hash: HASH });
      return spanAttribute('blockchain.contract.function.arguments');
    };
    expect(recorded(BOUNDS.functionArgumentsDepth - 1)).toEqual(expect.any(String));
    expect(recorded(BOUNDS.functionArgumentsDepth)).toEqual(expect.any(String));
    expect(recorded(BOUNDS.functionArgumentsDepth + 1)).toBeUndefined();
  });

  it.each([
    BOUNDS.authorizations - 1,
    BOUNDS.authorizations,
    BOUNDS.authorizations + 1,
    2 ** 32 - 1,
  ])('lists at most 64 of %i authorizations, reading no more, and counts them all', (length) => {
    const entry = { address: ADDRESS, chainId: 1 };
    const list = budgeted(
      length > 100_000 ? hugeSparse(entry).fill(entry, 0, 100) : dense(entry, length),
    );
    createTxTracker()
      .startSend({ ...SEND, authorizations: list.value })
      .end({ hash: HASH });
    expect(spanAttribute('blockchain.tx.authorization.count')).toBe(length);
    expect(spanAttribute('blockchain.tx.authorization.addresses')).toHaveLength(
      Math.min(length, BOUNDS.authorizations),
    );
    expect(list.reads()).toBeLessThanOrEqual(BOUNDS.authorizations * 2);
  });

  const distinctHashes = (length: number): string[] =>
    Array.from({ length }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`);

  it.each([
    BOUNDS.callBatchTransactionHashes - 1,
    BOUNDS.callBatchTransactionHashes,
    BOUNDS.callBatchTransactionHashes + 1,
  ])('records at most 64 of %i call batch transaction hashes', (length) => {
    createTxTracker()
      .startCallBatchConfirm(CALL_BATCH_CONFIRM)
      .end({
        statusCode: 200,
        receipts: distinctHashes(length).map((transactionHash) => ({ transactionHash })),
      });
    expect(spanAttribute('blockchain.call_batch.transaction_hashes')).toHaveLength(
      Math.min(length, BOUNDS.callBatchTransactionHashes),
    );
  });

  // finding: core-list-read-in-full. The receipts of a call batch status are read in full, though 64 hashes are kept.
  it.fails('reads no more call batch receipts than it records [finding: core-list-read-in-full]', () => {
    const receipts = budgeted(dense({ transactionHash: HASH, blockNumber: 1n }));
    createTxTracker()
      .startCallBatchConfirm(CALL_BATCH_CONFIRM)
      .end({ statusCode: 200, receipts: receipts.value });
    expect(receipts.reads()).toBeLessThanOrEqual(BOUNDS.callBatchTransactionHashes * 2);
  });

  // finding: core-list-read-in-full. The transaction hashes of a call batch send are read in full.
  it.fails('reads a bounded number of call batch transaction hashes [finding: core-list-read-in-full]', () => {
    const hashes = budgeted(dense(HASH));
    createTxTracker()
      .startCallBatchSend(CALL_BATCH)
      .end({ id: BATCH_ID, transactionHashes: hashes.value });
    expect(hashes.reads()).toBeLessThanOrEqual(BOUNDS.callBatchTransactionHashes * 2);
  });
});

// --- Rule 3: a value that fails validation is not recorded as another ---------------------------------------------

describe('values that fail validation', () => {
  // finding: core-receipt-status. A receipt status other than success or reverted is recorded as success.
  it.fails.each(['0x5', 'pending', undefined, 1])(
    'records no transaction status for a receipt status of %s [finding: core-receipt-status]',
    (status) => {
      createTxTracker()
        .startConfirm(CONFIRM)
        .end({ ...RECEIPT, status } as never);
      expect(spanAttribute('blockchain.tx.status')).toBeUndefined();
    },
  );

  it.each([MIXED_CASE_HASH, MIXED_CASE_ADDRESS])('accepts %s in mixed letter case', (value) => {
    createTxTracker()
      .startPayment({ ...PAYMENT, payer: MIXED_CASE_ADDRESS })
      .end({ status: 'settled', hash: MIXED_CASE_HASH });
    const span = tracing.spans()[0];
    expect(span?.attributes['blockchain.payment.payer']).toBe(MIXED_CASE_ADDRESS.toLowerCase());
    expect(span?.attributes['blockchain.tx.hash']).toBe(MIXED_CASE_HASH);
    expect(value).toBeDefined();
  });
});

// --- Rule 2: the inputs the core documents as read from own data properties run no getter --------------------------

describe('getters of the caller', () => {
  it.each([
    [
      'authorization entries',
      () => {
        const entry = countingGetters({ address: ADDRESS, chainId: 1 });
        createTxTracker()
          .startSend({ ...SEND, authorizations: [entry.value as never] })
          .end({ hash: HASH });
        return entry.reads();
      },
    ],
    [
      'function arguments',
      () => {
        const argument = countingGetters({ to: ADDRESS, amount: 1n });
        createTxTracker({ recordFunctionArguments: true })
          .startSend({ ...SEND, functionArguments: [argument.value] })
          .end({ hash: HASH });
        return argument.reads();
      },
    ],
    [
      'function arguments with Object.prototype keys',
      () => {
        const argument = prototypeKeyed(countingGetters({ x: 1 }).value);
        createTxTracker({ recordFunctionArguments: true })
          .startSend({ ...SEND, functionArguments: [argument] })
          .end({ hash: HASH });
        return 0;
      },
    ],
  ])('runs none in %s', (_name, run) => {
    expect(run()).toBe(0);
  });
});

// --- Rule 6: sensitive data stays opt-in --------------------------------------------------------------------------

describe('sensitive data with default options', () => {
  it('records no function arguments, error message or resource path', () => {
    const tracker = createTxTracker();
    tracker
      .startSend({ ...SEND, functionArguments: [SECRET] })
      .fail(new Error(`${SECRET_URL} ${ADDRESS}`));
    tracker
      .startPayment({ ...PAYMENT, x402: { resource: `${SECRET_URL}#${SECRET}` } })
      .end(SETTLEMENT as never);
    const recorded = JSON.stringify(
      tracing
        .spans()
        .map((span) => [span.attributes, span.events.map((event) => event.attributes)]),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(recorded).not.toContain(SECRET);
    expect(recorded).not.toContain('exception.message');
    expect(recorded).not.toContain('blockchain.contract.function.arguments');
  });

  it('keeps a URL credential out of a sanitized error message', () => {
    createTxTracker({ errorMessages: 'sanitized' }).startSend(SEND).fail(new Error(SECRET_URL));
    expect(eventAttribute('exception.message')).toBe('https://rpc.example.com');
  });
});
