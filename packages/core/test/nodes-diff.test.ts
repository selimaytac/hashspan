// Tests the comparison side of the dev-node matrix (scripts/nodes/) without a node: the three kinds of row, the
// candidate rule (a message that only words the same cause differently is never a candidate on its own), the known
// marks, the reduction of answers to shapes, unsupported flows kept apart from failed ones, the host-data check of the
// result files and the generated tables.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  byDesignRow,
  CAUSES,
  candidateReason,
  candidates,
  causesOf,
  KNOWN,
  namesWrongCause,
  REFERENCES,
  recordedRow,
  regressionRow,
  schemaRows,
  specRow,
  summarize,
  violationText,
} from '../../../scripts/nodes/diff.mjs';
import { runFlows } from '../../../scripts/nodes/flows.mjs';
import {
  buildResult,
  RESULTS_DIR,
  resultFile,
  resultProblems,
  resultText,
} from '../../../scripts/nodes/result.mjs';
import {
  dataShape,
  errorOf,
  fieldsOf,
  kindOf,
  receiptValues,
  sanitize,
} from '../../../scripts/nodes/rpc.mjs';
import { loadSpec } from '../../../scripts/nodes/schemas.mjs';
import { cell, DOC, END, START, table } from '../../../scripts/nodes/table.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const spec = loadSpec(root);

const receipt = {
  type: '0x2',
  status: '0x1',
  cumulativeGasUsed: '0x5208',
  logs: [],
  logsBloom: `0x${'0'.repeat(512)}`,
  transactionHash: `0x${'a'.repeat(64)}`,
  transactionIndex: '0x0',
  blockHash: `0x${'b'.repeat(64)}`,
  blockNumber: '0x1',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x77359400',
  from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  to: '0x000000000000000000000000000000000000dead',
  contractAddress: null,
};

/** A result of one node with the given flows. */
const resultOf = (name: string, flows: unknown[], extra: Record<string, unknown> = {}) =>
  buildResult({
    harness: { commit: '201d77d00000000000000000000000000000000a' },
    spec: {
      repo: 'https://github.com/ethereum/execution-apis',
      commit: '16caee274b0d4fb7a0316f294029adac88a75a09',
    },
    node: { name, title: name === 'geth' ? 'Geth --dev' : name, version: '1.0.0' },
    runDate: '2026-10-21',
    genesis: { chainId: 1337 },
    probes: {},
    flows,
    ...extra,
  });

const flow = (id: string, checks: unknown[], status = 'run') => ({
  flow: id,
  status,
  calls: [],
  checks,
});
const code = (got: unknown) =>
  recordedRow({ flow: 'invalid-input', call: 'nonce too low', field: 'code', got });
const message = (got: string) =>
  recordedRow({
    flow: 'invalid-input',
    call: 'nonce too low',
    field: 'message',
    got,
    cause: 'nonce',
  });

describe('rows', () => {
  it('matches a spec row or names a spec difference, with a known mark only on a difference', () => {
    const base = {
      flow: 'invalid-input',
      call: 'unknown method',
      field: 'code',
      ref: 'rpc-standard-errors.yaml',
    };
    expect(specRow({ ...base, expected: -32601, got: -32601, known: 'edr#1258' })).toEqual({
      ...base,
      kind: 'spec',
      expected: -32601,
      got: -32601,
      outcome: 'match',
    });
    expect(specRow({ ...base, expected: -32601, got: -32004, known: 'edr#1258' })).toMatchObject({
      outcome: 'spec-difference',
      known: 'edr#1258',
    });
    expect(specRow({ ...base, expected: -32601, got: -32004 })).not.toHaveProperty('known');
  });

  it('records an unspecified row, and checks a regression row against its upstream item', () => {
    expect(code(-32000)).toEqual({
      flow: 'invalid-input',
      call: 'nonce too low',
      field: 'code',
      kind: 'unspecified',
      got: -32000,
      outcome: 'recorded',
    });
    const regression = {
      flow: 'concurrent-send',
      call: 'sends',
      field: 'distinct nonces',
      expected: 5,
    };
    expect(regressionRow({ ...regression, got: 5, upstream: 'foundry#17354' })).toMatchObject({
      kind: 'unspecified',
      upstream: 'foundry#17354',
      outcome: 'match',
    });
    expect(
      regressionRow({ ...regression, got: 4, upstream: 'foundry#17354', known: 'foundry#17354' }),
    ).toMatchObject({
      outcome: 'difference',
      known: 'foundry#17354',
    });
  });

  it('keeps a chain mode extension as by-design, never a difference', () => {
    expect(
      byDesignRow({
        flow: 'anvil-tempo',
        call: 'receipt',
        field: 'extension fields',
        mode: 'tempo',
        got: ['feeToken'],
      }),
    ).toEqual({
      flow: 'anvil-tempo',
      call: 'receipt',
      field: 'extension fields',
      kind: 'by-design',
      mode: 'tempo',
      got: ['feeToken'],
      outcome: 'by-design',
    });
    const rows = schemaRows(spec, {
      flow: 'anvil-tempo',
      call: 'receipt',
      method: 'eth_getTransactionReceipt',
      result: {
        ...receipt,
        feeToken: '0x20c0000000000000000000000000000000000001',
        feePayer: receipt.from,
        blockTimestamp: 1,
      },
      byDesign: { mode: 'tempo', fields: ['feeToken', 'feePayer'] },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'spec',
        field: 'schema',
        outcome: 'spec-difference',
        got: ['/ additionalProperties blockTimestamp (number)'],
      }),
      expect.objectContaining({ kind: 'by-design', mode: 'tempo', got: ['feePayer', 'feeToken'] }),
    ]);
    // Without a chain mode the same fields are schema differences.
    expect(
      schemaRows(spec, {
        flow: 'eip1559',
        call: 'receipt',
        method: 'eth_getTransactionReceipt',
        result: { ...receipt, feeToken: receipt.from },
      }),
    ).toEqual([
      expect.objectContaining({ kind: 'spec', got: ['/ additionalProperties feeToken (string)'] }),
    ]);
    expect(violationText({ path: '/gasUsed', keyword: 'type', got: 'number' })).toBe(
      '/gasUsed type (number)',
    );
  });

  it('accepts as known marks only the four upstream items, never anything else', () => {
    expect(KNOWN).toEqual(['edr#1829', 'edr#1258', 'foundry#17462', 'foundry#17354']);
    const base = { flow: 'x', call: 'y', field: 'z', ref: 'r', expected: 1, got: 2 };
    expect(() => specRow({ ...base, known: 'bug-1' })).toThrow('known');
    expect(() => specRow({ ...base, known: 'reth#1' })).toThrow('known');
    expect(() => regressionRow({ ...base, upstream: 'geth#1' })).toThrow('known');
    expect(REFERENCES).toEqual(['geth', 'reth']);
  });
});

describe('candidate rule', () => {
  it('names the causes a message names', () => {
    expect(Object.keys(CAUSES)).toEqual(['nonce', 'fee', 'revert', 'gas', 'params', 'method']);
    expect(causesOf('nonce too low')).toEqual(['nonce']);
    expect(causesOf('max fee per gas less than block base fee')).toEqual(['fee']);
    expect(causesOf('execution reverted: nope')).toEqual(['revert']);
    expect(causesOf('Out of gas: gas required exceeds allowance: 100000')).toEqual(['gas']);
    expect(causesOf('the method hashspan_x does not exist/is not available')).toEqual(['method']);
    expect(namesWrongCause('nonce too low', 'fee')).toBe(true);
    expect(namesWrongCause('Nonce too low. Expected nonce to be 8 but got 0.', 'nonce')).toBe(
      false,
    );
    // A message that names no cause is only worded differently.
    expect(namesWrongCause('Transaction rejected', 'nonce')).toBe(false);
  });

  it('never makes a candidate of a message that words the same cause differently while the code agrees', () => {
    const refs = ['nonce too low: next nonce 8, tx nonce 0'];
    expect(
      candidateReason(message('Nonce too low. Expected nonce to be 8 but got 0.'), refs),
    ).toBeUndefined();
    expect(candidateReason(message('transaction rejected'), refs)).toBeUndefined();
    // A message that names another cause is one, with or without references.
    expect(candidateReason(message('transaction underpriced'), refs)).toBe('cause');
    expect(candidateReason(message('transaction underpriced'), [])).toBe('cause');
  });

  it('makes a candidate of a code that differs from references that agree', () => {
    expect(candidateReason(code(-32003), [-32000, -32000])).toBe('code');
    expect(candidateReason(code(-32000), [-32000, -32000])).toBeUndefined();
    // References that disagree, or none, leave the row recorded only.
    expect(candidateReason(code(-32003), [-32000, -32010])).toBeUndefined();
    expect(candidateReason(code(-32003), [])).toBeUndefined();
  });

  it('makes a candidate of a missing field or one of another kind, not of an extra field', () => {
    const fields = (got: string[]) =>
      recordedRow({ flow: 'eip1559', call: 'receipt', field: 'fields', got });
    const ref = ['blockHash:hash32', 'blobGasPrice:quantity', 'status:quantity'];
    expect(candidateReason(fields(['blockHash:hash32', 'status:quantity']), [ref])).toBe('field');
    expect(
      candidateReason(fields(['blockHash:hash32', 'blobGasPrice:number', 'status:quantity']), [
        ref,
      ]),
    ).toBe('field');
    expect(candidateReason(fields([...ref, 'blockTimestamp:number']), [ref])).toBeUndefined();
  });

  it('makes a candidate of another value, and of a regression row that differs without a known mark', () => {
    const value = (got: string) =>
      recordedRow({ flow: 'estimate-gas', call: 'transfer', field: 'value', got });
    expect(candidateReason(value('0x5209'), ['0x5208', '0x5208'])).toBe('value');
    const row = {
      flow: 'concurrent-send',
      call: 'sends',
      field: 'distinct nonces',
      expected: 5,
      got: 4,
    };
    expect(candidateReason(regressionRow({ ...row, upstream: 'foundry#17354' }), [])).toBe('value');
    expect(
      candidateReason(
        regressionRow({ ...row, upstream: 'foundry#17354', known: 'foundry#17354' }),
        [],
      ),
    ).toBeUndefined();
    // A spec difference is counted as a spec difference, not again as a candidate.
    expect(
      candidateReason(
        specRow({ flow: 'a', call: 'b', field: 'c', ref: 'r', expected: 1, got: 2 }),
        [],
      ),
    ).toBeUndefined();
  });

  it('compares each node with Geth and Reth, and a reference with the other reference only', () => {
    const geth = resultOf('geth', [flow('invalid-input', [code(-32000)])]);
    const reth = resultOf('reth', [flow('invalid-input', [code(-32003)])]);
    const anvil = resultOf('anvil', [flow('invalid-input', [code(-32003)])]);
    const both = candidates([anvil, geth, reth]);
    // Geth and Reth disagree, so Anvil's code is recorded only; each reference differs from the other.
    expect(both.get(anvil)).toEqual([]);
    expect(both.get(geth)).toEqual([
      { flow: 'invalid-input', call: 'nonce too low', field: 'code', reason: 'code' },
    ]);
    const one = candidates([anvil, geth]);
    expect(one.get(anvil)).toEqual([
      { flow: 'invalid-input', call: 'nonce too low', field: 'code', reason: 'code' },
    ]);
    expect(one.get(geth)).toEqual([]);
  });
});

describe('answers reduced to shapes', () => {
  it('keeps the kind of a value, never a hash, address or time', () => {
    expect(kindOf(`0x${'a'.repeat(64)}`)).toBe('hash32');
    expect(kindOf('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe('address');
    expect(kindOf('0x5208')).toBe('quantity');
    expect(kindOf('0x0052')).toBe('bytes2');
    expect(kindOf(1792593373)).toBe('number');
    expect(kindOf(null)).toBe('null');
    expect(fieldsOf({ b: '0x1', a: null })).toEqual(['a:null', 'b:quantity']);
    expect(receiptValues(receipt)).toEqual({
      type: '0x2',
      status: '0x1',
      gasUsed: '0x5208',
      transactionIndex: '0x0',
      logs: 0,
      contractAddress: 'null',
    });
  });

  it('keeps an error as its code, a sanitized message and the shape of its data', () => {
    expect(dataShape(`0x08c379a0${'00'.repeat(96)}`)).toBe('0x08c379a0 (100 bytes)');
    expect(dataShape(undefined)).toBe('absent');
    expect(dataShape({ stackTrace: [] })).toBe('object');
    expect(errorOf({ code: 3, message: 'execution reverted', data: '0x' })).toEqual({
      code: 3,
      message: 'execution reverted',
      data: '0x (0 bytes)',
    });
    expect(sanitize(`custom error 0xcb362b34:\u0000\u0000\u0007 at /Users/a/b 10.0.0.1`)).toBe(
      'custom error 0xcb362b34: at <path> <address>',
    );
    // Returned text that names the word is withheld, as results never use it.
    expect(sanitize('a known Bug in the node')).toBe('<text withheld>');
  });
});

describe('flows that cannot run', () => {
  it('keeps unsupported flows apart from failed ones, and neither counts as a difference', async () => {
    const flows = [
      { id: 'simulate', needs: 'eth_simulateV1', run: async () => {} },
      {
        id: 'deploy',
        run: async () => {
          throw new Error('the node answered nothing at /home/someone/x');
        },
      },
      { id: 'estimate-gas', run: async () => {} },
    ];
    const out = await runFlows(
      { rpc: {}, chainId: 1, probes: { eth_simulateV1: 'unsupported' }, node: {} },
      spec,
      flows,
    );
    expect(out.map((f: { flow: string; status: string }) => [f.flow, f.status])).toEqual([
      ['simulate', 'unsupported'],
      ['deploy', 'failed'],
      ['estimate-gas', 'run'],
    ]);
    expect(out[0]).toMatchObject({ needs: 'eth_simulateV1', checks: [] });
    expect(out[1]?.error).toBe('the node answered nothing at <path>');
    expect(summarize(resultOf('anvil', out))).toMatchObject({
      flows: 3,
      run: 1,
      unsupported: 1,
      failed: 1,
      differences: 0,
    });
  });
});

describe('result files', () => {
  it('are named by node and version', () => {
    expect(resultFile('anvil', '1.8.5')).toBe('anvil@1.8.5.json');
    expect(resultFile('anvil-nightly', '2026-10-21')).toBe('anvil-nightly@2026-10-21.json');
    expect(() => resultFile('../x', '1')).toThrow();
    expect(() => resultFile('anvil', '1/2')).toThrow();
    expect(RESULTS_DIR).toBe('docs/nodes/results');
    expect(() => resultOf('anvil', [], { runDate: '2026-10-21T10:00:00Z' })).toThrow('date');
  });

  it('refuse host data, hashes, Unix times and the word bug', () => {
    const clean = resultText(resultOf('anvil', [flow('legacy', [code(-32000)])]));
    expect(resultProblems(clean, ['some-host'])).toEqual([]);
    expect(resultProblems(`${clean} /Users/someone/x`)).toContain('a file path');
    expect(resultProblems(`${clean} 10.1.2.3`)).toContain('the address 10.1.2.3');
    expect(resultProblems(`${clean} 2026-10-21T10:00`)).toContain('a time of day');
    expect(resultProblems(`${clean} some-host`, ['some-host'])).toContain('a host value');
    expect(resultProblems(`${clean} 0x${'a'.repeat(64)}`)).toContain(
      'a hash, key or raw transaction',
    );
    expect(resultProblems(`${clean} "blockTimestamp": 1792593373`)).toContain('a Unix time');
    expect(resultProblems(`${clean} a bug`)).toContain('the word bug');
    // A commit id and hex quantities are not flagged.
    expect(
      resultProblems(`${clean} 51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f 0x21e19e0c9bab2400000`),
    ).toEqual([]);
  });

  it('hold no result yet, and every committed one passes the check', () => {
    const files = readdirSync(join(root, RESULTS_DIR)).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      expect({
        file,
        problems: resultProblems(readFileSync(join(root, RESULTS_DIR, file), 'utf8')),
      }).toEqual({
        file,
        problems: [],
      });
    }
  });
});

describe('tables', () => {
  it('say there are no results before the first run', () => {
    expect(table([])).toBe('No results yet: the first lab run of the matrix writes them.');
    const doc = readFileSync(join(root, DOC), 'utf8');
    expect(doc).toContain(START);
    expect(doc).toContain(END);
  });

  it('escape pipes, backslashes and line breaks in a cell', () => {
    expect(cell('a|b\\c\nd')).toBe('a\\|b\\\\c d');
  });

  it('show each node, each row with the expected column, and mark spec differences, known items and candidates', () => {
    const anvil = resultOf(
      'anvil',
      [
        flow('invalid-input', [
          code(-32003),
          message('nonce too | low'),
          specRow({
            flow: 'invalid-input',
            call: 'unknown method',
            field: 'code',
            ref: 'r',
            expected: -32601,
            got: -32601,
          }),
        ]),
        flow('concurrent-send', [
          regressionRow({
            flow: 'concurrent-send',
            call: 'sends',
            field: 'distinct nonces',
            expected: 5,
            got: 4,
            upstream: 'foundry#17354',
            known: 'foundry#17354',
          }),
        ]),
        flow('simulate', [], 'unsupported'),
      ],
      {
        chainModes: [
          {
            flow: 'anvil-tempo',
            mode: 'tempo',
            status: 'run',
            checks: [
              byDesignRow({
                flow: 'anvil-tempo',
                call: 'receipt',
                field: 'extension fields',
                mode: 'tempo',
                got: ['feePayer', 'feeToken'],
              }),
            ],
          },
        ],
      },
    );
    const geth = resultOf('geth', [
      flow('invalid-input', [
        code(-32000),
        message('nonce too low: next nonce 8, tx nonce 0'),
        specRow({
          flow: 'invalid-input',
          call: 'unknown method',
          field: 'code',
          ref: 'r',
          expected: -32601,
          got: -32004,
          known: 'edr#1258',
        }),
      ]),
      flow('concurrent-send', [
        regressionRow({
          flow: 'concurrent-send',
          call: 'sends',
          field: 'distinct nonces',
          expected: 5,
          got: 5,
          upstream: 'foundry#17354',
        }),
      ]),
      flow('simulate', []),
    ]);
    const text = table([
      { file: 'anvil@1.0.0.json', result: anvil },
      { file: 'geth@1.0.0.json', result: geth },
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      '| Node | Version | Chain id | Spec rows matched | Spec differences | Known upstream | Candidates | Unspecified rows | By design | Unsupported flows | Failed flows | Run |',
    );
    expect(lines[2]).toBe(
      '| anvil | `1.0.0` | 1337 | 1 of 1 | 0 | 1 | 1 | 2 | 1 | 1 | 0 | [2026-10-21](nodes/results/anvil@1.0.0.json) |',
    );
    expect(text).toContain(
      '| `invalid-input` | nonce too low | code | *unspecified* | **`-32003`** (candidate: code) | `-32000` |',
    );
    // Same cause in other words: recorded, never a candidate; the pipe of the message is escaped.
    expect(text).toContain(
      '| `invalid-input` | nonce too low | message | *unspecified* | `nonce too \\| low` |',
    );
    expect(text).toContain(
      '| `invalid-input` | unknown method | code | `-32601` | `-32601` | **`-32004`** (known: edr#1258) |',
    );
    expect(text).toContain(
      '| `concurrent-send` | sends | distinct nonces | `5` (foundry#17354) | **`4`** (known: foundry#17354) | `5` (foundry#17354: fixed here) |',
    );
    expect(text).toContain('| `simulate` | all | - | - | *unsupported* | *run* |');
    expect(text).toContain('| Chain mode | Call | Field | Expected | anvil |');
    expect(text).toContain(
      '| `anvil-tempo` | receipt | extension fields | *by design: tempo* | `feePayer, feeToken` |',
    );
    expect(text).not.toMatch(/\bbugs?\b/i);
  });
});
