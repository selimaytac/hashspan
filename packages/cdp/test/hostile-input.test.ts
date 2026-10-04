// ADR 0025: `withHashspan(cdp, { reader })` with the hostile-input table of `core/test/hostile.ts`, applied to the
// caller's arguments, to what the CDP SDK returns, to the reader and tracker passed in, and to the client itself. Each
// value runs untraced and traced on a fake SDK client: the traced call must have the same outcome and run no more
// getters of the caller's; what it records must keep the rules. A rule that does not hold yet is marked `it.fails`
// with `// finding: <tag>`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdapterRow,
  type AdapterScenario,
  countingGetters,
  describeAdapterRows,
  HostileError,
  type HostileTracing,
  hostileErrors,
  hostileValues,
  recordingMeterProvider,
  revokedProxy,
  setupHostileTracing,
  throwingProxy,
} from '../../core/test/hostile.js';
import { type WithHashspanCdpOptions, withHashspan } from '../src/index.js';

let tracing: HostileTracing;
const meters = recordingMeterProvider();
beforeAll(() => {
  tracing = setupHostileTracing();
});
afterAll(async () => {
  await tracing.teardown();
});

const HASH = `0x${'ab'.repeat(32)}`;
const OP_HASH = `0x${'01'.repeat(32)}`;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SMART = '0x5555555555555555555555555555555555555555';
const TO = '0x2222222222222222222222222222222222222222';

/** What the fake SDK answers; each is called per call, so a row can make one hostile. */
interface Answers {
  send?(): unknown;
  userOperation?(): unknown;
  wait?(): unknown;
  account?(): unknown;
  receipt?(): unknown;
}

/** A server account shaped like the SDK's; its network-scoped form waits through the SDK's own client. */
function fakeAccount(answers: Answers) {
  const sent = async () => (answers.send ? answers.send() : { transactionHash: HASH });
  return {
    address: ACCOUNT,
    sendTransaction: sent,
    transfer: sent,
    async useNetwork(network: string) {
      return {
        address: ACCOUNT,
        network,
        sendTransaction: sent,
        transfer: sent,
        waitForTransactionReceipt: async () =>
          answers.receipt
            ? answers.receipt()
            : { transactionHash: HASH, status: 'success', blockNumber: 1n, gasUsed: 21_000n },
      };
    },
  };
}

/** A CDP client shaped like the SDK's: methods on the class, so the adapter wraps them in place. */
function fakeCdp(answers: Answers = {}) {
  class EvmClient {
    async sendTransaction(_options: unknown) {
      return answers.send ? answers.send() : { transactionHash: HASH };
    }
    async getOrCreateAccount(_options: unknown) {
      return answers.account ? answers.account() : fakeAccount(answers);
    }
    async sendUserOperation(_options: unknown) {
      return answers.userOperation
        ? answers.userOperation()
        : { smartAccountAddress: SMART, status: 'broadcast', userOpHash: OP_HASH };
    }
    async waitForUserOperation(_options: unknown) {
      return answers.wait
        ? answers.wait()
        : {
            smartAccountAddress: SMART,
            status: 'complete',
            transactionHash: HASH,
            userOpHash: OP_HASH,
          };
    }
  }
  return { evm: new EvmClient() };
}

// biome-ignore lint/suspicious/noExplicitAny: SDK methods are called with hostile arguments on purpose.
type Any = any;
type Options = WithHashspanCdpOptions | undefined;
type Row = AdapterRow<WithHashspanCdpOptions>;

/** The fake client, wrapped when `options` are given, and how to flush it. */
function client(options: Options, answers: Answers = {}) {
  const cdp = fakeCdp(answers);
  const hashspan = options ? withHashspan(cdp, options) : undefined;
  return {
    evm: cdp.evm as Any,
    flush: async () => (hashspan ? hashspan.flush({ timeoutMs: 3_000 }) : true),
  };
}

/** A scenario calling `call` on the fake client. */
const on =
  (call: (evm: Any, args: unknown) => unknown, answers: Answers = {}) =>
  (args: unknown, options: Options): AdapterScenario => {
    const { evm, flush } = client(options, answers);
    return { call: () => call(evm, args), flush };
  };

/** Rows for each field of `base`, the argument object of a call. */
function argumentRows(
  name: string,
  base: Record<string, unknown>,
  scenario: (args: unknown, options: Options) => AdapterScenario,
  findings: Record<string, Row['findings']> = {},
): Row[] {
  return [
    ...Object.keys(base).map(
      (key): Row => ({
        name: `${name} ${key}`,
        args: true,
        scenario: (value, options, getters) => {
          const args = { ...base, [key]: value };
          if (!getters) return scenario(args, options);
          const counted = countingGetters(args);
          return { ...scenario(counted.value, options), reads: counted.reads };
        },
        ...(findings[key] ? { findings: findings[key] } : {}),
      }),
    ),
    { name: `${name} arguments`, scenario: (value, options) => scenario(value, options) },
  ];
}

/** Rows for answers of the SDK: `answers(value)` makes one of them hostile. */
const answerRow = (
  name: string,
  answers: (value: unknown) => Answers,
  call: (evm: Any) => unknown,
  findings?: Row['findings'],
): Row => ({
  name,
  scenario: (value, options) => on((evm) => call(evm), answers(value))(undefined, options),
  ...(findings ? { findings } : {}),
});

const sendTransaction = (evm: Any, args: unknown) => evm.sendTransaction(args);
const SEND = {
  address: ACCOUNT,
  network: 'base',
  transaction: { to: TO, value: 1n, data: '0xa9059cbb' },
};

const ROWS: Row[] = [
  // The caller's arguments.
  ...argumentRows('cdp.evm.sendTransaction', SEND, on(sendTransaction)),
  ...argumentRows(
    'cdp.evm.sendTransaction transaction',
    { to: TO, value: 1n, nonce: 1, data: '0xa9059cbb' },
    on((evm, transaction) => evm.sendTransaction({ ...SEND, transaction })),
  ),
  ...argumentRows(
    'account.transfer',
    { to: TO, amount: 1n, token: 'eth', network: 'base' },
    on(async (evm, args) => (await evm.getOrCreateAccount({ name: 'a' })).transfer(args)),
  ),
  ...argumentRows(
    'cdp.evm.sendUserOperation',
    { smartAccount: { address: SMART }, network: 'base', calls: [{ to: TO, value: 1n }] },
    on((evm, args) => evm.sendUserOperation(args)),
  ),
  ...argumentRows(
    'cdp.evm.waitForUserOperation',
    { userOpHash: OP_HASH, smartAccountAddress: SMART },
    on(async (evm, args) => {
      await evm.sendUserOperation({ smartAccount: { address: SMART }, network: 'base', calls: [] });
      return evm.waitForUserOperation(args);
    }),
  ),
  ...argumentRows(
    'scoped account waitForTransactionReceipt',
    { hash: HASH },
    on(async (evm, args) => {
      const scoped = await (await evm.getOrCreateAccount({ name: 'a' })).useNetwork('base');
      return scoped.waitForTransactionReceipt(args);
    }),
  ),

  // What the SDK returns.
  answerRow(
    'SDK answer to sendTransaction',
    (value) => ({ send: () => value }),
    (evm) => evm.sendTransaction(SEND),
  ),
  answerRow(
    'SDK answer to sendTransaction transactionHash',
    (value) => ({ send: () => ({ transactionHash: value }) }),
    (evm) => evm.sendTransaction(SEND),
  ),
  answerRow(
    'SDK answer to sendUserOperation userOpHash',
    (value) => ({ userOperation: () => ({ smartAccountAddress: SMART, userOpHash: value }) }),
    (evm) =>
      evm.sendUserOperation({ smartAccount: { address: SMART }, network: 'base', calls: [] }),
  ),
  ...(['status', 'transactionHash'] as const).map((field) =>
    answerRow(
      `SDK answer to waitForUserOperation ${field}`,
      (value) => ({
        wait: () => ({
          status: 'complete',
          transactionHash: HASH,
          userOpHash: OP_HASH,
          [field]: value,
        }),
      }),
      async (evm) => {
        await evm.sendUserOperation({
          smartAccount: { address: SMART },
          network: 'base',
          calls: [],
        });
        return evm.waitForUserOperation({ userOpHash: OP_HASH });
      },
    ),
  ),
  answerRow(
    'SDK answer to getOrCreateAccount',
    (value) => ({ account: () => value }),
    async (evm) => {
      const account = await evm.getOrCreateAccount({ name: 'a' });
      return typeof account?.sendTransaction === 'function'
        ? account.sendTransaction(SEND)
        : account;
    },
  ),
  answerRow(
    'SDK answer to a scoped waitForTransactionReceipt',
    (value) => ({ receipt: () => value }),
    async (evm) =>
      (
        await (await evm.getOrCreateAccount({ name: 'a' })).useNetwork('base')
      ).waitForTransactionReceipt({ hash: HASH }),
  ),
  answerRow(
    'SDK rejection of sendTransaction',
    (value) => ({
      send: () => {
        throw value;
      },
    }),
    (evm) => evm.sendTransaction(SEND),
  ),
  answerRow(
    'SDK rejection of sendUserOperation',
    (value) => ({
      userOperation: () => {
        throw value;
      },
    }),
    (evm) =>
      evm.sendUserOperation({ smartAccount: { address: SMART }, network: 'base', calls: [] }),
  ),

  // A reader and a tracker passed in: the user's, so only rule 1 applies.
  {
    name: 'options.reader',
    rules: ['same'],
    options: (value) => ({ reader: value as never }),
    scenario: (_value, options) => on(sendTransaction)(SEND, options),
  },
  {
    name: 'options.reader returning',
    rules: ['same'],
    options: (value) => ({ reader: () => value as never }),
    scenario: (_value, options) => on(sendTransaction)(SEND, options),
  },
  {
    name: 'options.tracker',
    rules: ['same'],
    options: (value) => ({ tracker: value as never }),
    scenario: async (_value, options) => {
      const { evm, flush } = client(options);
      return {
        call: async () => {
          await evm.sendTransaction(SEND);
          await evm.sendUserOperation({
            smartAccount: { address: SMART },
            network: 'base',
            calls: [],
          });
          return evm.waitForUserOperation({ userOpHash: OP_HASH });
        },
        flush,
      };
    },
  },
];

/** The rejection values of the SDK rows are errors; every other row takes the general table. */
const valuesOf = (row: Row): Row =>
  row.name.startsWith('SDK rejection of ') ? { ...row, values: hostileErrors } : row;

describe('hostile input', () => {
  describeAdapterRows(ROWS.map(valuesOf), {
    // The scenario wraps its own fake client with these options.
    instrument: (options) => options as WithHashspanCdpOptions,
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

describe('the client withHashspan() wraps', () => {
  it('never throws for a client it cannot wrap', () => {
    const problems: string[] = [];
    for (const [label, cdp] of [
      ...hostileValues(),
      ['a client whose evm is a throwing Proxy', { evm: throwingProxy() }],
      ['a client whose evm is revoked', { evm: revokedProxy() }],
      ['a client whose evm is frozen', { evm: Object.freeze(fakeCdp().evm) }],
    ] as [string, unknown][]) {
      try {
        withHashspan(cdp as never);
      } catch (error) {
        problems.push(
          `${label}: ${error instanceof HostileError ? 'HostileError' : String(error)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
