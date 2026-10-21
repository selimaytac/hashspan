// Compares what a dev node answered with the spec and with the other nodes. Three kinds of row:
// - `spec`: the vendored execution-apis spec (or JSON-RPC 2.0) states the answer, so a mismatch is a spec difference;
// - `unspecified`: the spec is silent (error messages, most error codes, gas values), so the answer is recorded and
//   compared across nodes, with Geth and Reth as the references; a row with an expected value from an upstream item
//   (a regression row) is a match or a difference;
// - `by-design`: an extension a node adds on purpose, such as the L2 fields of a chain mode; never a difference.
// A candidate is what the gate looks at: a code that differs from the references, a field that is missing or of
// another kind, a value that differs, or a message that names the wrong cause. A message that only words the same
// cause differently is recorded and never a candidate on its own. Text says what was returned or stored; no
// difference is called anything else until a filing has passed the upstream gate.
import { validateResult } from './schemas.mjs';

/** The upstream items a `known:` mark may name: filed already, so a difference they describe is not new. */
export const KNOWN = ['edr#1829', 'edr#1258', 'foundry#17462', 'foundry#17354'];

/** The nodes whose answers are the reference where the spec is silent. */
export const REFERENCES = ['geth', 'reth'];

/** The causes an invalid input can have, each with the words a message naming it uses. */
export const CAUSES = {
  nonce: /nonce/i,
  fee: /underpriced|fee|gas ?price|tip|base ?fee/i,
  revert: /revert/i,
  gas: /out of gas|gas required|allowance|gas limit|intrinsic|gas too low/i,
  params: /param|argument|invalid|decode|deserial|length|parse|missing/i,
  method: /method|not found|not supported|unsupported|not available|does not exist/i,
};

/** The causes a message names. */
export const causesOf = (message) =>
  Object.entries(CAUSES)
    .filter(([, words]) => words.test(String(message)))
    .map(([cause]) => cause);

/**
 * Whether a message names another cause than its own: it names at least one cause and not `cause`. A message that
 * names none, or names its own among others, is only worded differently.
 */
export function namesWrongCause(message, cause) {
  const named = causesOf(message);
  return named.length > 0 && !named.includes(cause);
}

const checkKnown = (known) => {
  if (known !== undefined && !KNOWN.includes(known)) {
    throw new Error(`known: names an upstream item of ${KNOWN.join(', ')}, not ${known}`);
  }
};

/**
 * A `spec` row: `expected` is what the spec states, `ref` where.
 * @param {{ flow: string, call: string, field: string, ref: string, expected: unknown, got: unknown, known?: string }} row
 */
export function specRow({ flow, call, field, ref, expected, got, known }) {
  checkKnown(known);
  const outcome = same(got, expected) ? 'match' : 'spec-difference';
  return {
    flow,
    call,
    field,
    kind: 'spec',
    ref,
    expected,
    got,
    outcome,
    ...(outcome === 'spec-difference' && known !== undefined ? { known } : {}),
  };
}

/**
 * An `unspecified` row: recorded and compared across nodes; `cause` is the cause a message should name.
 * @param {{ flow: string, call: string, field: string, got: unknown, cause?: string }} row
 */
export const recordedRow = ({ flow, call, field, got, cause }) => ({
  flow,
  call,
  field,
  kind: 'unspecified',
  got,
  outcome: 'recorded',
  ...(cause === undefined ? {} : { cause }),
});

/**
 * An expectation row where the spec is silent: `expected` comes from an upstream item (`upstream`, a regression row)
 * or from what a real chain returned (a chain-mode row). `known` is set when the pinned version is known not to have
 * the fix yet; `detail` is what else the row shows (recorded with it, not compared on its own).
 * @param {{ flow: string, call: string, field: string, expected: unknown, got: unknown, upstream?: string, known?: string, detail?: unknown }} row
 */
export function regressionRow({ flow, call, field, expected, got, upstream, known, detail }) {
  checkKnown(upstream);
  checkKnown(known);
  const outcome = same(got, expected) ? 'match' : 'difference';
  return {
    flow,
    call,
    field,
    kind: 'unspecified',
    expected,
    got,
    ...(upstream === undefined ? {} : { upstream }),
    ...(detail === undefined ? {} : { detail }),
    outcome,
    ...(outcome === 'difference' && known !== undefined ? { known } : {}),
  };
}

/**
 * A `by-design` row: an extension of a chain mode, recorded and never a difference.
 * @param {{ flow: string, call: string, field: string, mode: string, got: unknown }} row
 */
export const byDesignRow = ({ flow, call, field, mode, got }) => ({
  flow,
  call,
  field,
  kind: 'by-design',
  mode,
  got,
  outcome: 'by-design',
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One violation as text, without any value: `/logs/0 additionalProperties blockTimestamp (number)`. */
export const violationText = (v) =>
  [v.path, v.keyword, v.property, v.got === undefined ? undefined : `(${v.got})`]
    .filter((x) => x !== undefined)
    .join(' ');

/**
 * The rows of a result validated against the method's result schema: a `spec` row (`valid`, or the violations), and,
 * for a chain mode, a `by-design` row with the extra properties at the top level that the mode adds on purpose.
 * @param {any} spec
 * @param {{ flow: string, call: string, method: string, result: unknown, ref?: string, byDesign?: { mode: string, fields: string[] } }} options
 */
export function schemaRows(spec, { flow, call, method, result, ref, byDesign }) {
  const violations = validateResult(spec, method, result);
  const extension = (v) =>
    byDesign !== undefined &&
    v.keyword === 'additionalProperties' &&
    byDesign.fields.includes(v.property) &&
    // The extension of a receipt: the receipt itself, or each receipt of a list.
    /^\/(\d+)?$/.test(v.path);
  const ext = violations.filter(extension);
  const rest = violations.filter((v) => !extension(v)).map(violationText);
  const rows = [
    specRow({
      flow,
      call,
      field: 'schema',
      ref: ref ?? `execution-apis ${method} result`,
      expected: 'valid',
      got: rest.length ? [...new Set(rest)] : 'valid',
    }),
  ];
  if (ext.length) {
    rows.push(
      byDesignRow({
        flow,
        call,
        field: 'extension fields',
        mode: byDesign.mode,
        got: [...new Set(ext.map((v) => v.property))].sort(),
      }),
    );
  }
  return rows;
}

/** Counts of one result's flows and rows; candidates need the other results, see `candidates`. */
export function summarize(result) {
  const flows = result.flows ?? [];
  const modes = result.chainModes ?? [];
  const rows = [...flows, ...modes].flatMap((f) => f.checks ?? []);
  const spec = rows.filter((r) => r.kind === 'spec');
  const expectations = rows.filter((r) => r.kind === 'unspecified' && r.expected !== undefined);
  return {
    flows: flows.length,
    run: flows.filter((f) => f.status === 'run').length,
    unsupported: flows.filter((f) => f.status === 'unsupported').length,
    failed: flows.filter((f) => f.status === 'failed').length,
    spec: spec.length,
    matched: spec.filter((r) => r.outcome === 'match').length,
    differences: spec.filter((r) => r.outcome === 'spec-difference' && !r.known).length,
    known: rows.filter((r) => r.known !== undefined).length,
    recorded: rows.filter((r) => r.outcome === 'recorded').length,
    expectations: expectations.length,
    expectationsMatched: expectations.filter((r) => r.outcome === 'match').length,
    byDesign: rows.filter((r) => r.kind === 'by-design').length,
    chainModes: modes.length,
  };
}

const rowKey = (r) => `${r.flow}\u0000${r.call}\u0000${r.field}`;

/** The field names of a field list (`name:kind`), and each name's kind. */
const kindsOf = (fields) => new Map(fields.map((f) => f.split(':')).map(([k, v]) => [k, v]));

/** The top-level properties a schema row names as forbidden extras (`/ additionalProperties <name> (...)`). */
const extraProperties = (schemaRow) =>
  Array.isArray(schemaRow?.got)
    ? schemaRow.got.flatMap((v) => /^\/(?:\d+)? ?additionalProperties (\S+)/.exec(v)?.[1] ?? [])
    : [];

/**
 * Why one recorded row is a candidate, given the reference nodes' rows for it, or undefined when it is not. `refs` are
 * the `got` values of the references that ran it; `forbidden` the fields a reference adds that the spec forbids.
 */
export function candidateReason(row, refs, forbidden = []) {
  if (row.kind === 'unspecified' && row.expected !== undefined) {
    return row.outcome === 'difference' && !row.known ? 'value' : undefined;
  }
  if (row.outcome !== 'recorded') return undefined;
  if (row.field === 'message') {
    return row.cause !== undefined && namesWrongCause(row.got, row.cause) ? 'cause' : undefined;
  }
  if (refs.length === 0 || !refs.every((v) => same(v, refs[0]))) return undefined;
  const ref = refs[0];
  if (same(row.got, ref)) return undefined;
  if (row.field === 'code') return 'code';
  if (row.field === 'fields' && Array.isArray(row.got) && Array.isArray(ref)) {
    const got = kindsOf(row.got);
    // Only a missing field or one of another kind; an extra field alone is recorded, and a field the spec forbids
    // that a reference adds is not missing on a node that keeps to the spec.
    for (const [name, kind] of kindsOf(ref)) {
      if (forbidden.includes(name)) continue;
      if (!got.has(name) || got.get(name) !== kind) return 'field';
    }
    return undefined;
  }
  return 'value';
}

/**
 * Rows of one node that an upstream item already describes, so the table shows its mark instead of a difference
 * from the references; `known` names the item, with "by design" where its maintainers said so.
 */
export const KNOWN_ROWS = [
  {
    node: 'hardhat',
    flow: 'estimate-gas',
    call: 'transfer',
    field: 'value',
    known: 'edr#542, by design',
  },
  { node: 'hardhat', flow: 'fee-history', call: 'feeHistory', field: 'fields', known: 'edr#390' },
];

const knownRow = (node, row) =>
  KNOWN_ROWS.find(
    (k) => k.node === node && k.flow === row.flow && k.call === row.call && k.field === row.field,
  )?.known;

/**
 * The candidates of a set of results, by result: the rows the gate looks at, each with its reason (`code`, `field`,
 * `value`, `cause`). A reference node is compared with the other reference only.
 */
export function candidates(results) {
  const refs = results.filter((r) => REFERENCES.includes(r.node.name));
  const index = new Map(
    refs.map((r) => [
      r,
      new Map(
        (r.flows ?? [])
          .filter((f) => f.status === 'run')
          .flatMap((f) => f.checks ?? [])
          .map((c) => [rowKey(c), c]),
      ),
    ]),
  );
  return new Map(
    results.map((r) => {
      const out = [];
      for (const f of [...(r.flows ?? []), ...(r.chainModes ?? [])]) {
        if (f.status !== 'run') continue;
        for (const row of f.checks ?? []) {
          const others = refs.filter((ref) => ref !== r);
          const values = others
            .map((ref) => index.get(ref).get(rowKey(row)))
            .filter((c) => c?.outcome === 'recorded')
            .map((c) => c.got);
          const forbidden = others.flatMap((ref) =>
            extraProperties(index.get(ref).get(rowKey({ ...row, field: 'schema' }))),
          );
          const reason = candidateReason(row, values, forbidden);
          if (!reason) continue;
          const known = knownRow(r.node.name, row);
          out.push({
            flow: row.flow,
            call: row.call,
            field: row.field,
            reason,
            ...(known ? { known } : {}),
          });
        }
      }
      return [r, out];
    }),
  );
}
