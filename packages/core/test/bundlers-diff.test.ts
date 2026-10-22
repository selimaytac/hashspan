// Tests the diff of the ERC-4337 bundler matrix (scripts/bundlers/) without Docker: answers and receipts reduced to
// the compared fields, the expectation check with its known marks and rows not reached, EntryPoints a target can run,
// the fault invariants, the result files (no host data, no hash or payload, no bug wording) and the tables.
import { encodeErrorResult, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { reasonOf, USER_OPERATION_EVENT_TOPIC } from '../../../scripts/bundlers/chain.mjs';
import { ENTRY_POINTS } from '../../../scripts/bundlers/corpus.mjs';
import {
  aaOf,
  agreement,
  caseStatus,
  checkExpectations,
  checkInvariants,
  KNOWN,
  logTail,
  observeAnswer,
  observeEstimate,
  observeReadBack,
  paymasterForm,
  sanitize,
  shouldRetryStart,
  summarize,
  usableEntryPoints,
} from '../../../scripts/bundlers/diff.mjs';
import { buildResult, resultProblems, resultText } from '../../../scripts/bundlers/result.mjs';
import { cell, table } from '../../../scripts/bundlers/table.mjs';

const HASH = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;
const TX = `0x${'12'.repeat(32)}`;
const BLOCK = `0x${'34'.repeat(32)}`;
const SENDER = '0xE35b1E23D30eE88b357AB51f10E75b02bcFa7ae6';
const EP = ENTRY_POINTS['0.7'];

const event = {
  transactionHash: TX,
  blockHash: BLOCK,
  blockNumber: 7n,
  sender: SENDER,
  paymaster: `0x${'0'.repeat(40)}`,
  nonce: 0n,
  success: true,
  actualGasCost: 1000n,
  actualGasUsed: 100n,
  bundleStatus: 'success',
  bundleLogs: 3,
};
const bundleLogs = [0, 1, 2].map((i) => ({
  transactionHash: TX,
  logIndex: `0x${i}`,
  topics: [] as string[],
}));
const receipt = {
  userOpHash: HASH,
  entryPoint: EP.toLowerCase(),
  sender: SENDER,
  nonce: '0x0',
  paymaster: `0x${'0'.repeat(40)}`,
  actualGasCost: '0x3e8',
  actualGasUsed: '0x64',
  success: true,
  logs: [bundleLogs[1]],
  receipt: { transactionHash: TX, logs: bundleLogs },
};
const byHash = { entryPoint: EP, transactionHash: TX, blockHash: BLOCK, blockNumber: '0x7' };
const readBack = (overrides: Record<string, unknown> = {}) =>
  observeReadBack({
    userOpHash: HASH,
    entryPoint: EP,
    receipt,
    byHash,
    chain: [event],
    topic: USER_OPERATION_EVENT_TOPIC,
    ...overrides,
  });

describe('observed answers', () => {
  it('reduces a hash, an error object, a page without JSON-RPC and no answer at all', () => {
    expect(observeAnswer(200, { jsonrpc: '2.0', id: 1, result: HASH })).toEqual({
      status: 200,
      answer: 'result',
      accepted: true,
    });
    expect(
      observeAnswer(200, {
        error: { code: -32500, message: `AA21 didn't pay prefund for ${SENDER}` },
      }),
    ).toEqual({
      status: 200,
      answer: 'error',
      accepted: false,
      code: -32500,
      aa: 'AA21',
      message: "AA21 didn't pay prefund for <hex>",
    });
    expect(observeAnswer(500, undefined)).toEqual({
      status: 500,
      answer: 'no-json-rpc',
      accepted: false,
    });
    expect(observeAnswer(undefined, undefined, 'timeout')).toEqual({ answer: 'timeout' });
    expect(observeAnswer(undefined, undefined, 'request failed: ECONNRESET')).toEqual({
      answer: 'connection',
      error: 'request failed: ECONNRESET',
    });
    expect(aaOf('FailedOp(0, "AA25 invalid account nonce")')).toBe('AA25');
    expect(aaOf('no code')).toBeUndefined();
  });

  it('reduces an estimate to whether it has every field ERC-7769 names, never the values', () => {
    const full = {
      result: { preVerificationGas: '0x1', verificationGasLimit: '0x2', callGasLimit: '0x3' },
    };
    expect(observeEstimate(200, full)).toEqual({
      status: 200,
      answer: 'result',
      'estimate.fields': 'complete',
    });
    expect(observeEstimate(200, { result: { callGasLimit: '0x3' } })['estimate.fields']).toBe(
      'missing: preVerificationGas, verificationGasLimit',
    );
  });

  it('strips hashes, addresses, paths, IP addresses and times, and withholds the word bug', () => {
    expect(sanitize(`tx ${HASH} from ${SENDER}`)).toBe('tx <hex> from <hex>');
    expect(sanitize('at /Users/a/b and /tmp/c')).toBe('at <path> and <path>');
    expect(sanitize('node 10.0.0.2 or 127.0.0.1 at 2026-10-21T10:00:00Z')).toBe(
      'node <address> or 127.0.0.1 at <time>',
    );
    expect(sanitize('a known bug')).toBe('<text withheld>');
    expect(sanitize('x'.repeat(300))).toHaveLength(200);
  });

  it('keeps the last lines of a container log, sanitized, for a start that failed', () => {
    const log = [
      'starting',
      '',
      'loaded /home/someone/app/config.json',
      'error: bad flag --rpc_url',
    ].join('\n');
    expect(logTail(log)).toBe('starting\nloaded <path>\nerror: bad flag --rpc_url');
    expect(logTail(log, 1)).toBe('error: bad flag --rpc_url');
    expect(logTail(undefined)).toBe('');
  });

  it('starts a bundler again only when its port was still in use', () => {
    expect(
      shouldRetryStart(
        'CRITICAL Bind failed. [Errno 98] Address already in use for RPC url <address> and port 4337',
      ),
    ).toBe(true);
    expect(shouldRetryStart('Voltaire: error: You must specify either --bundler_secret')).toBe(
      false,
    );
    expect(shouldRetryStart(undefined)).toBe(false);
  });

  it('shows a revert reason as its decoded text or selector, never the bytes', () => {
    const boom = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['boom'],
    });
    expect(reasonOf(boom)).toBe('Error(boom)');
    expect(reasonOf('0x')).toBe('empty');
    expect(reasonOf(undefined)).toBe('absent');
    expect(reasonOf('0xdeadbeef00')).toBe('selector 0xdeadbeef');
    expect(paymasterForm(undefined)).toBe('absent');
    expect(paymasterForm('0x')).toBe('empty');
    expect(paymasterForm(`0x${'0'.repeat(40)}`)).toBe('zero-address');
    expect(paymasterForm(SENDER)).toBe('address');
  });
});

describe('read-back against the chain', () => {
  it('takes a receipt of the ERC-7769 shape that agrees with the chain', () => {
    expect(readBack()).toEqual({
      included: true,
      'chain.events': 1,
      'receipt.shape': 'complete',
      'receipt.success': true,
      'receipt.paymaster': 'zero-address',
      'receipt.reason': 'absent',
      'receipt.matchesChain': true,
      'receipt.logsOwn': true,
      'receipt.logCount': 1,
      'receipt.bundleReceipt': 'whole-bundle',
      'byHash.matchesChain': true,
    });
    expect(JSON.stringify(readBack())).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('names the missing fields, a value that differs from the event, and a pending answer', () => {
    const { paymaster: _p, logs: _l, ...partial } = receipt;
    expect(readBack({ receipt: partial })['receipt.shape']).toBe('missing: paymaster, logs');
    expect(
      readBack({ receipt: { ...receipt, actualGasCost: '0x3e9' } })['receipt.matchesChain'],
    ).toBe(false);
    expect(readBack({ receipt: { ...receipt, entryPoint: SENDER } })['receipt.matchesChain']).toBe(
      false,
    );
    expect(readBack({ byHash: { ...byHash, blockNumber: null } })['byHash.matchesChain']).toBe(
      false,
    );
    expect(readBack({ receipt: null, chain: [] })).toEqual({ included: false, 'chain.events': 0 });
    expect(readBack({ chain: [] })['receipt.matchesChain']).toBe(false);
  });

  it("takes logs as the operation's own only when they are in the bundle and none is another's event", () => {
    const othersEvent = {
      transactionHash: TX,
      logIndex: '0x2',
      topics: [USER_OPERATION_EVENT_TOPIC, OTHER],
    };
    const logs = [bundleLogs[0], bundleLogs[1], othersEvent];
    const withOthers = { ...receipt, logs, receipt: { transactionHash: TX, logs } };
    expect(readBack({ receipt: withOthers })['receipt.logsOwn']).toBe(false);
    const outside = { transactionHash: OTHER, logIndex: '0x0', topics: [] };
    expect(readBack({ receipt: { ...receipt, logs: [outside] } })['receipt.logsOwn']).toBe(false);
    // The receipt of only this operation's logs, not the whole bundle's (hashspan#431).
    const own = { ...receipt, receipt: { transactionHash: TX, logs: [bundleLogs[1]] } };
    expect(readBack({ receipt: own })['receipt.bundleReceipt']).toBe('differs');
  });
});

describe('expectations', () => {
  const observed = {
    steps: [
      { call: 'send', op: 'main', answer: 'error', accepted: false, code: -32602 },
      { call: 'wait', op: 'main', included: false },
    ],
    effect: { landed: 'none' },
  };

  it('checks spec rows, records unspecified ones and marks rows of an operation never included', () => {
    const checks = checkExpectations(
      [
        { step: 0, field: 'accepted', kind: 'spec', value: false, ref: 'r' },
        { step: 0, field: 'code', kind: 'spec', value: -32500, ref: 'r' },
        { step: 0, field: 'aa', kind: 'unspecified' },
        {
          step: 1,
          field: 'receipt.success',
          kind: 'spec',
          value: false,
          ref: 'r',
          when: 'included',
        },
        { field: 'effect.landed', kind: 'unspecified' },
      ],
      observed,
    );
    expect(checks.map((c: { outcome: string }) => c.outcome)).toEqual([
      'match',
      'spec-difference',
      'recorded',
      'not-reached',
      'recorded',
    ]);
    expect(checks[2]).toMatchObject({ got: 'absent' });
    expect(summarize([{ case: 'x', status: 'run', checks }])).toMatchObject({
      spec: 2,
      matched: 1,
      differences: 1,
      known: 0,
      notReached: 1,
      recorded: 2,
    });
  });

  it('carries a known mark on a difference only, and only for an upstream item of the list', () => {
    expect(KNOWN).toEqual(['rundler#1354']);
    const row = {
      step: 0,
      field: 'answer',
      kind: 'spec',
      value: 'error',
      ref: 'r',
      known: 'rundler#1354',
    };
    const dropped = { steps: [{ answer: 'connection' }] };
    expect(checkExpectations([row], dropped)[0]).toMatchObject({
      outcome: 'spec-difference',
      known: 'rundler#1354',
    });
    expect(checkExpectations([row], { steps: [{ answer: 'error' }] })[0]).not.toHaveProperty(
      'known',
    );
    expect(() => checkExpectations([{ ...row, known: 'a bug' }], dropped)).toThrow('known: names');
  });

  it('runs a case only on an EntryPoint the target lists and the chain has; the rest is unsupported', () => {
    // A bundler may list an address in lower case; the chain read is keyed by the address as listed.
    const listed = [ENTRY_POINTS['0.7'].toLowerCase(), ENTRY_POINTS['0.8']];
    expect(
      usableEntryPoints(
        listed,
        { [listed[0] as string]: true, [ENTRY_POINTS['0.8']]: false },
        ENTRY_POINTS,
      ),
    ).toEqual(['0.7']);
    expect(
      usableEntryPoints([ENTRY_POINTS['0.8']], { [ENTRY_POINTS['0.8']]: false }, ENTRY_POINTS),
    ).toEqual([]);
    expect(usableEntryPoints(undefined, {}, ENTRY_POINTS)).toEqual([]);
    expect(caseStatus({ entryPoint: '0.7' }, ['0.7'])).toBe('run');
    expect(caseStatus({ entryPoint: '0.8' }, ['0.7'])).toBe('unsupported');
    expect(summarize([{ case: 'x', status: 'unsupported', checks: [] }])).toMatchObject({
      unsupported: 1,
      spec: 0,
    });
  });

  it('compares one field across targets, unsupported apart', () => {
    const result = (name: string, got: unknown, status = 'run') => ({
      target: { name },
      conformance: [{ case: 'c', status, checks: [{ step: 0, field: 'code', got }] }],
    });
    expect(agreement([result('a', -32500), result('b', -32500)], 'c', 0, 'code').agree).toBe(true);
    expect(agreement([result('a', -32500), result('b', -32602)], 'c', 0, 'code').agree).toBe(false);
    expect(agreement([result('a', -32500), result('b', 0, 'unsupported')], 'c', 0, 'code')).toEqual(
      {
        values: { a: -32500, b: 'unsupported' },
        agree: true,
      },
    );
  });
});

describe('fault invariants', () => {
  const accepted = { answer: 'result', accepted: true };
  const failed = { answer: 'error', accepted: false, code: -32603 };
  const included = { included: true, 'chain.events': 1, 'receipt.matchesChain': true };
  const pending = { included: false, 'chain.events': 0 };
  const run = (steps: unknown[], afterPass: number, exercised = true) =>
    checkInvariants({ steps, effect: {} }, { afterPass, exercised });
  const failing = (invariants: { id: string; holds: boolean | null }[]) =>
    invariants.filter((i) => i.holds === false).map((i) => i.id);

  it('hold for an operation included once with a receipt that agrees', () => {
    expect(failing(run([accepted, included, failed, included], 1))).toEqual([]);
    expect(run([accepted, included, failed, included], 1).map((i) => i.id)).toEqual([
      'no-receipt-without-mined-bundle',
      'included-at-most-once',
      'receipt-matches-chain',
      'no-inclusion-after-reported-failure',
    ]);
  });

  it('flag a receipt without a mined bundle, a double inclusion and a receipt that differs', () => {
    expect(
      failing(run([accepted, { included: true, 'chain.events': 0 }, failed, pending], 0)),
    ).toEqual(['no-receipt-without-mined-bundle', 'receipt-matches-chain']);
    expect(failing(run([accepted, included, accepted, included], 2))).toEqual([
      'included-at-most-once',
    ]);
  });

  it('flag an inclusion after a reported failure unless the retry announced it', () => {
    expect(failing(run([failed, pending, failed, pending], 1))).toEqual([
      'no-inclusion-after-reported-failure',
    ]);
    expect(failing(run([failed, pending, accepted, included], 1))).toEqual([]);
    expect(
      failing(run([{ answer: 'no-json-rpc', accepted: false }, pending, failed, pending], 1)),
    ).toEqual(['no-inclusion-after-reported-failure']);
    // A timeout reports nothing, so an inclusion after it is no reported failure.
    expect(failing(run([{ answer: 'timeout' }, pending, failed, pending], 1))).toEqual([]);
  });

  it('count nothing for a scenario whose fault was never reached', () => {
    expect(run([failed, pending, failed, pending], 1, false).every((i) => i.holds === null)).toBe(
      true,
    );
  });
});

describe('result files and tables', () => {
  const result = (overrides: Record<string, unknown> = {}) =>
    buildResult({
      corpus: { id: 'erc4337-v07-anvil-1', sha256: 'a'.repeat(64) },
      harness: { commit: 'b'.repeat(40) },
      target: { name: 'rundler', title: 'Rundler', version: 'v0.11.0', commit: 'c'.repeat(40) },
      anvil: {
        image: 'ghcr.io/foundry-rs/foundry:v1.8.4',
        digest: `sha256:${'d'.repeat(64)}`,
        chainId: 1337,
      },
      runDate: '2026-10-21',
      probes: {
        chainId: 1337,
        chainIdMatches: true,
        supportedEntryPoints: ['0.7'],
        usable: ['0.7'],
      },
      egress: { conformanceRequests: 12, faultCasesWithoutRequests: 0 },
      conformance: [
        {
          case: 'plain-op',
          status: 'run',
          checks: [
            {
              step: 1,
              field: 'accepted',
              kind: 'spec',
              expected: true,
              got: true,
              outcome: 'match',
            },
            {
              step: 2,
              field: 'receipt.reason',
              kind: 'unspecified',
              got: 'a|b',
              outcome: 'recorded',
            },
          ],
        },
        {
          case: 'pre-verification-gas-out-of-range',
          status: 'run',
          checks: [
            {
              step: 0,
              field: 'answer',
              kind: 'spec',
              expected: 'error',
              got: 'connection',
              outcome: 'spec-difference',
              known: 'rundler#1354',
            },
          ],
        },
        { case: 'v08-case', status: 'unsupported', checks: [] },
      ],
      faults: [
        {
          case: 'plain-op',
          scenario: 'eth_call:hang',
          exercised: true,
          invariants: [{ id: 'x', holds: true }],
        },
        {
          case: 'plain-op',
          scenario: 'eth_call:drop',
          exercised: false,
          invariants: [{ id: 'x', holds: null }],
        },
      ],
      ...overrides,
    });

  it('accept a result of answers only, and refuse host data, hashes, payloads and the word bug', () => {
    expect(resultProblems(resultText(result()))).toEqual([]);
    expect(resultProblems(`{"x": "${HASH}"}`)).toEqual(['a hash or payload']);
    expect(resultProblems('{"x": "/Users/someone/x"}')).toEqual(['a file path']);
    expect(resultProblems('{"x": "0.0.0.0"}')).toEqual(['the address 0.0.0.0']);
    expect(resultProblems('{"x": "a bug"}')).toEqual(['the word bug']);
    expect(resultProblems('{"x": "laptop-7"}', ['laptop-7'])).toEqual(['a host value']);
    expect(() => result({ runDate: '2026-10-21T10:00' })).toThrow('date');
  });

  it('say there are no results yet before the first run', () => {
    expect(table([])).toBe('No results yet: the first lab run of the matrix writes them.');
  });

  it('render one row per target and one per field, escaping cells and keeping unsupported apart', () => {
    const text = table([{ file: 'rundler@v0.11.0.json', result: result() }]);
    expect(text).toContain(
      '| Rundler | `v0.11.0` | 0.7 | 1 of 2 | 0 | 1 | 0 | 1 | 1 | 1 of 1 hold | 1 | 12 |',
    );
    expect(text).toContain('[2026-10-21](bundlers/results/rundler@v0.11.0.json)');
    expect(text).toContain('`a\\|b`');
    expect(text).toContain('**`connection`** (known: rundler#1354)');
    expect(text).toContain('| `v08-case` | all | - | *unsupported* |');
    expect(cell('a|b\\c\nd')).toBe('a\\|b\\\\c d');
    expect(text).not.toMatch(/\bbugs?\b/i);
  });
});
