// Tests the comparison side of the facilitator conformance matrix (scripts/facilitators/) without Docker: what a
// facilitator answered, checked against the corpus's expectations, the fault invariants, the result files with their
// host-data check, and the generated table.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agreement,
  caseStatus,
  checkExpectations,
  checkInvariants,
  KNOWN,
  observeCall,
  sanitize,
  summarize,
  supportedSchemes,
} from '../../../scripts/facilitators/diff.mjs';
import {
  buildResult,
  RESULTS_DIR,
  resultFile,
  resultProblems,
  resultText,
} from '../../../scripts/facilitators/result.mjs';
import { table } from '../../../scripts/facilitators/table.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const valid = { status: 200, isValid: true };
const settled = { status: 200, success: true, transaction: 'present' };

describe('observed calls', () => {
  it('keeps the fields the matrix compares and whether a transaction came back', () => {
    expect(
      observeCall(200, {
        isValid: false,
        invalidReason: 'invalid_exact_evm_signature',
        payer: '0x1',
      }),
    ).toEqual({ status: 200, isValid: false, invalidReason: 'invalid_exact_evm_signature' });
    expect(
      observeCall(200, { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'x' }),
    ).toEqual({ status: 200, success: true, transaction: 'present' });
    expect(observeCall(200, { success: false, errorReason: 'x', transaction: '' })).toEqual({
      status: 200,
      success: false,
      errorReason: 'x',
      transaction: 'empty',
    });
    expect(observeCall(500, { error: 'boom at /home/someone/x.py' })).toEqual({
      status: 500,
      error: 'boom at <path>',
    });
    expect(observeCall(undefined, undefined, 'timeout')).toEqual({ timeout: true });
  });

  it('strips hashes, signatures, paths, addresses and times from returned text', () => {
    expect(sanitize(`tx 0x${'a'.repeat(64)} sig 0x${'b'.repeat(130)}`)).toBe('tx <hex> sig <hex>');
    expect(sanitize('at C:\\x and /Users/a/b and /tmp/c')).toBe('at <path> and <path> and <path>');
    expect(sanitize('rpc 10.1.2.3 and 127.0.0.1:8545')).toBe('rpc <address> and 127.0.0.1:8545');
    expect(sanitize('at 2026-10-21T10:00:00.123Z')).toBe('at <time>');
    expect(sanitize('x'.repeat(400))).toHaveLength(200);
    // Returned text that names the word is withheld rather than reworded.
    expect(sanitize('a known Bug here')).toBe('<text withheld>');
    expect(sanitize('debug output')).toBe('debug output');
  });
});

describe('expectations', () => {
  const expect_ = [
    { step: 0, field: 'isValid', kind: 'spec', value: false, ref: 'x402-specification-v2.md §9' },
    {
      step: 0,
      field: 'invalidReason',
      kind: 'spec',
      value: 'invalid_exact_evm_payload_signature',
      ref: 'x402-specification-v2.md §9',
    },
    { step: 1, field: 'success', kind: 'unspecified' },
    { field: 'effect.payTo', kind: 'spec', value: '0', ref: 'scheme_exact_evm.md §1 Phase 3' },
  ];

  it('matches spec rows, names spec differences, and only records unspecified rows', () => {
    const checks = checkExpectations(expect_, {
      steps: [
        { status: 200, isValid: false, invalidReason: 'invalid_exact_evm_signature' },
        { status: 200, success: false, errorReason: 'x', transaction: 'empty' },
      ],
      effect: { payTo: '0', payer: '0' },
    });
    expect(checks).toEqual([
      { step: 0, field: 'isValid', kind: 'spec', expected: false, got: false, outcome: 'match' },
      {
        step: 0,
        field: 'invalidReason',
        kind: 'spec',
        expected: 'invalid_exact_evm_payload_signature',
        got: 'invalid_exact_evm_signature',
        outcome: 'spec-difference',
      },
      { step: 1, field: 'success', kind: 'unspecified', got: false, outcome: 'recorded' },
      { field: 'effect.payTo', kind: 'spec', expected: '0', got: '0', outcome: 'match' },
    ]);
  });

  it('carries a known mark only on a spec difference, and records an absent field as absent', () => {
    const known = [
      { field: 'effect.payTo', kind: 'spec', value: '3000', ref: 'x', known: 'x402#3730' },
    ];
    expect(checkExpectations(known, { steps: [], effect: { payTo: '0' } })).toEqual([
      {
        field: 'effect.payTo',
        kind: 'spec',
        expected: '3000',
        got: '0',
        outcome: 'spec-difference',
        known: 'x402#3730',
      },
    ]);
    expect(
      checkExpectations(known, { steps: [], effect: { payTo: '3000' } })[0],
    ).not.toHaveProperty('known');
    expect(
      checkExpectations([{ step: 0, field: 'invalidReason', kind: 'unspecified' }], {
        steps: [{ status: 200, isValid: true }],
        effect: {},
      })[0].got,
    ).toBe('absent');
    expect(() =>
      checkExpectations([{ field: 'x', kind: 'spec', value: 1, ref: 'r', known: 'bug-1' }], {
        steps: [],
        effect: {},
      }),
    ).toThrow('known');
    expect(KNOWN).toEqual(['x402#3730', 'x402-rs#136', 'qntx#73']);
  });
});

describe('/supported', () => {
  const supported = {
    kinds: [
      { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
      { x402Version: 1, scheme: 'upto', network: 'eip155:84532' },
      { x402Version: 2, scheme: 'upto', network: 'eip155:1' },
      { x402Version: 2, scheme: 'batch-settlement', network: 'eip155:84532' },
    ],
  };

  it('offers the v2 schemes of the matrix network only', () => {
    expect([...supportedSchemes(supported, 'eip155:84532')].sort()).toEqual([
      'batch-settlement',
      'exact',
    ]);
    expect([...supportedSchemes({}, 'eip155:84532')]).toEqual([]);
  });

  it('keeps a scheme the target does not offer apart from a failure', () => {
    const schemes = supportedSchemes(supported, 'eip155:84532');
    expect(caseStatus({ scheme: 'exact' }, schemes)).toBe('run');
    expect(caseStatus({ scheme: 'upto' }, schemes)).toBe('unsupported');
    const summary = summarize([
      {
        case: 'a',
        status: 'run',
        checks: [
          { kind: 'spec', outcome: 'match' },
          { kind: 'spec', outcome: 'spec-difference' },
          { kind: 'spec', outcome: 'spec-difference', known: 'x402#3730' },
          { kind: 'unspecified', outcome: 'recorded' },
        ],
      },
      { case: 'b', status: 'unsupported', checks: [] },
    ]);
    expect(summary).toEqual({
      cases: 2,
      run: 1,
      unsupported: 1,
      spec: 3,
      matched: 1,
      differences: 1,
      known: 1,
      recorded: 1,
    });
  });
});

describe('fault invariants', () => {
  const run = (settle: object, retry: object, afterSettle: string, afterRetry: string) =>
    checkInvariants(
      { steps: [valid, settle, retry], effect: { afterSettle, afterRetry } },
      { amount: '10000' },
    );

  it('hold for a clean failure and a retry that settles once', () => {
    const failed = { status: 200, success: false, errorReason: 'x', transaction: 'empty' };
    expect(run(failed, settled, '0', '10000')).toEqual([
      { id: 'no-success-without-transfer', holds: true },
      { id: 'no-failure-after-transfer', holds: true },
      { id: 'pending-carries-transaction', holds: true },
      { id: 'moves-once', holds: true },
    ]);
  });

  it('flag success without a mined transfer and a failure after one', () => {
    const failed = { status: 200, success: false, errorReason: 'x', transaction: 'empty' };
    expect(run(settled, settled, '0', '0')[0]).toEqual({
      id: 'no-success-without-transfer',
      holds: false,
    });
    expect(run(failed, failed, '10000', '10000')[1]).toEqual({
      id: 'no-failure-after-transfer',
      holds: false,
    });
    expect(
      checkInvariants(
        { steps: [valid, failed, failed], effect: { afterSettle: '10000', afterRetry: '10000' } },
        { amount: '10000', known: ['x402-rs#136'] },
      )[1],
    ).toEqual({ id: 'no-failure-after-transfer', holds: false, known: 'x402-rs#136' });
    expect(run({ timeout: true }, settled, '10000', '10000')[1]?.holds).toBe(false);
  });

  it('accept settlement_pending after a mined transfer only with its transaction', () => {
    const pending = { status: 200, success: false, errorReason: 'settlement_pending' };
    const withTx = { ...pending, transaction: 'present' };
    expect(run(withTx, settled, '10000', '10000').every((i) => i.holds)).toBe(true);
    expect(run({ ...pending, transaction: 'empty' }, settled, '10000', '10000')[2]).toEqual({
      id: 'pending-carries-transaction',
      holds: false,
    });
  });

  it('flag funds moved twice', () => {
    expect(run(settled, settled, '10000', '20000')[3]).toEqual({ id: 'moves-once', holds: false });
  });
});

describe('agreement across targets', () => {
  it('lists each target value of one field and says whether they agree', () => {
    const results = ['typescript', 'go', 'python'].map((name, i) => ({
      target: { name },
      conformance: [
        {
          case: 'c',
          status: name === 'python' ? 'unsupported' : 'run',
          checks: [{ step: 0, field: 'invalidReason', got: i === 0 ? 'a' : 'b' }],
        },
      ],
    }));
    expect(agreement(results, 'c', 0, 'invalidReason')).toEqual({
      values: { typescript: 'a', go: 'b', python: 'unsupported' },
      agree: false,
    });
    expect(agreement(results.slice(1), 'c', 0, 'invalidReason').agree).toBe(true);
  });
});

/** A result as a run writes it, for the table and the host-data check. */
function sample(name: string, overrides: Record<string, unknown> = {}) {
  return buildResult({
    corpus: { id: 'x402-v2-anvil-1', sha256: 'a'.repeat(64) },
    harness: { commit: 'b'.repeat(40) },
    target: {
      name,
      title: `x402 e2e facilitator (${name})`,
      repo: 'https://github.com/x402-foundation/x402',
      commit: 'faa1c694c66a3732aaabbce93bdae140e521a67d',
    },
    anvil: { image: 'ghcr.io/foundry-rs/foundry:v1.8.4', digest: null, chainId: 84532 },
    runDate: '2026-10-22',
    supported: ['exact', 'upto'],
    egress: { conformanceRequests: 12, faultCasesWithoutRequests: 0 },
    conformance: [
      {
        case: 'exact-eip3009-bad-signature',
        status: 'run',
        observed: {
          steps: [{ status: 200, isValid: false, invalidReason: 'invalid_exact_evm_signature' }],
        },
        checks: [
          {
            step: 0,
            field: 'invalidReason',
            kind: 'spec',
            expected: 'invalid_exact_evm_payload_signature',
            got: 'invalid_exact_evm_signature',
            outcome: 'spec-difference',
          },
        ],
      },
      { case: 'batch-refund-before-settle', status: 'unsupported', checks: [] },
    ],
    faults: [
      {
        case: 'exact-eip3009-valid',
        scenario: 'eth_getTransactionReceipt:reset',
        invariants: [
          { id: 'no-success-without-transfer', holds: true },
          { id: 'no-failure-after-transfer', holds: false },
        ],
      },
    ],
    ...overrides,
  });
}

describe('facilitator matrix results', () => {
  const files = readdirSync(join(root, RESULTS_DIR)).filter((f) => f.endsWith('.json'));

  it.each(files)('%s is named after its target and commit and holds no host data', (file) => {
    const text = readFileSync(join(root, RESULTS_DIR, file), 'utf8');
    const result = JSON.parse(text);
    expect(resultFile(result.target.name, result.target.commit)).toBe(file);
    expect(text).toBe(resultText(result));
    expect(resultProblems(text)).toEqual([]);
  });

  it('names a result after the target and the short commit', () => {
    expect(resultFile('typescript', 'faa1c694c66a3732aaabbce93bdae140e521a67d')).toBe(
      'typescript@faa1c694.json',
    );
  });

  it('refuses host data, payload signatures and the word bug in a result', () => {
    expect(resultProblems(resultText(sample('go')))).toEqual([]);
    expect(resultProblems('"at /Users/someone/x"')).toEqual(['a file path']);
    expect(resultProblems(`"0x${'c'.repeat(130)}"`)).toEqual(['a signature or payload']);
    expect(resultProblems('"a bug in the facilitator"')).toEqual(['the word bug']);
    expect(resultProblems('"made on box-42"', ['box-42'])).toEqual(['a host value']);
    expect(() => sample('go', { runDate: '2026-10-22T10:00' })).toThrow('runDate');
  });
});

describe('facilitator matrix table', () => {
  it('says no results yet before the first lab run', () => {
    expect(table([])).toBe('No results yet: the first lab run of the matrix writes them.');
  });

  it('shows offered schemes, spec differences and unsupported cases apart', () => {
    const results = [
      { file: 'go@faa1c694.json', result: sample('go') },
      { file: 'typescript@faa1c694.json', result: sample('typescript') },
    ];
    const text = table(results);
    expect(text).toContain(
      '| x402 e2e facilitator (go) | `faa1c694` | exact, upto | 0 of 1 | 1 | 0 | 0 | 1 | 1 of 2 hold | 12 | [2026-10-22](facilitators/results/go@faa1c694.json) |',
    );
    expect(text).toContain(
      '| `exact-eip3009-bad-signature` | invalidReason (step 0) | `invalid_exact_evm_payload_signature` | **`invalid_exact_evm_signature`** | **`invalid_exact_evm_signature`** |',
    );
    expect(text).toContain(
      '| `batch-refund-before-settle` | all | - | *unsupported* | *unsupported* |',
    );
    expect(text).not.toMatch(/\bbugs?\b/i);
  });

  it('escapes backslashes and pipes in table cells', () => {
    const result = sample('go');
    const text = table([
      {
        file: 'go@faa1c694.json',
        result: { ...result, target: { ...result.target, title: 'a\\|b' } },
      },
    ]);
    expect(text).toContain('a\\\\\\|b');
  });
});
