// Compares what a facilitator answered with the corpus: each call reduced to the fields the matrix compares, each
// expectation checked (`spec`) or recorded (`unspecified`), the invariants of the fault pass, and the values of one
// field across targets. Text describes what was returned or stored; a spec difference is not called anything else
// until a filing has passed the upstream gate.

/** The upstream items a `known:` mark may name: filed already, so a difference they describe is not new. */
export const KNOWN = ['x402#3730', 'x402-rs#136', 'qntx#73'];

const LONG_HEX = /0x[0-9a-fA-F]{64,}/g;
const PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|root|private|tmp|var\/folders)\/)[^\s"',)]*/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const DATETIME = /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;
const WORD = /\bbugs?\b/i;
const MAX_TEXT = 200;

/**
 * Text a facilitator returned, made safe for a result: hashes and signatures, paths, addresses other than
 * 127.0.0.1 and times are replaced, and it is cut to 200 characters. Text that names the word bug is withheld, as
 * results never use it.
 */
export function sanitize(text) {
  const clean = String(text)
    .replace(LONG_HEX, '<hex>')
    .replace(PATH, '<path>')
    .replace(IPV4, (ip) => (ip === '127.0.0.1' ? ip : '<address>'))
    .replace(DATETIME, '<time>');
  if (WORD.test(clean)) return '<text withheld>';
  return clean.slice(0, MAX_TEXT);
}

/**
 * One /verify or /settle answer, reduced to the compared fields: the HTTP status, `isValid` and `invalidReason`,
 * `success` and `errorReason`, whether a `transaction` came back (`present` or `empty`, never the hash), and an error
 * text. `failure` is `timeout` when the harness gave up waiting.
 */
export function observeCall(status, body, failure) {
  if (failure === 'timeout') return { timeout: true };
  const out = { status };
  if (failure !== undefined) out.error = sanitize(failure);
  if (body === null || typeof body !== 'object') return out;
  if (typeof body.isValid === 'boolean') out.isValid = body.isValid;
  if (typeof body.invalidReason === 'string') out.invalidReason = sanitize(body.invalidReason);
  if (typeof body.success === 'boolean') out.success = body.success;
  if (typeof body.errorReason === 'string') out.errorReason = sanitize(body.errorReason);
  if (typeof body.transaction === 'string')
    out.transaction = body.transaction ? 'present' : 'empty';
  for (const key of ['error', 'detail', 'message']) {
    if (out.error === undefined && body[key] !== undefined) {
      out.error = sanitize(typeof body[key] === 'string' ? body[key] : JSON.stringify(body[key]));
    }
  }
  return out;
}

/** The value of an expectation's field in an observation: a step's field, or an effect (`effect.payTo`). */
function fieldValue(observed, e) {
  if (e.field.startsWith('effect.')) return observed.effect?.[e.field.slice(7)] ?? 'absent';
  return observed.steps?.[e.step]?.[e.field] ?? 'absent';
}

/**
 * Checks a case's expectations against what was observed. A `spec` row is a `match` or a `spec-difference` (with its
 * `known` mark, when the difference is one filed upstream); an `unspecified` row is `recorded`, for the comparison
 * across targets.
 */
export function checkExpectations(expectations, observed) {
  return expectations.map((e) => {
    if (e.known !== undefined && !KNOWN.includes(e.known)) {
      throw new Error(`known: names an upstream item of ${KNOWN.join(', ')}, not ${e.known}`);
    }
    const got = fieldValue(observed, e);
    const where = e.step === undefined ? {} : { step: e.step };
    if (e.kind === 'unspecified')
      return { ...where, field: e.field, kind: e.kind, got, outcome: 'recorded' };
    const outcome = got === e.value ? 'match' : 'spec-difference';
    return {
      ...where,
      field: e.field,
      kind: e.kind,
      expected: e.value,
      got,
      outcome,
      ...(outcome === 'spec-difference' && e.known !== undefined ? { known: e.known } : {}),
    };
  });
}

/** The v2 schemes a target's /supported answer offers on `network`. */
export function supportedSchemes(supported, network) {
  const kinds = Array.isArray(supported?.kinds) ? supported.kinds : [];
  return new Set(
    kinds
      .filter((k) => Number(k?.x402Version) === 2 && k?.network === network)
      .map((k) => String(k.scheme)),
  );
}

/** `run` when the target offers the case's scheme, else `unsupported`: not a failure, and shown apart. */
export const caseStatus = (c, schemes) => (schemes.has(c.scheme) ? 'run' : 'unsupported');

/** Counts of a target's conformance pass. */
export function summarize(conformance) {
  const checks = conformance.flatMap((c) => c.checks ?? []);
  const spec = checks.filter((c) => c.kind === 'spec');
  return {
    cases: conformance.length,
    run: conformance.filter((c) => c.status === 'run').length,
    unsupported: conformance.filter((c) => c.status === 'unsupported').length,
    spec: spec.length,
    matched: spec.filter((c) => c.outcome === 'match').length,
    differences: spec.filter((c) => c.outcome === 'spec-difference' && !c.known).length,
    known: spec.filter((c) => c.outcome === 'spec-difference' && c.known).length,
    recorded: checks.filter((c) => c.outcome === 'recorded').length,
  };
}

const settledNow = (call) => call?.success === true;

/**
 * The invariants of one fault case: steps are verify, the faulted settle and its retry; `effect.afterSettle` and
 * `effect.afterRetry` are what reached the case's own receiver after each, and `effect.afterPass` what had reached it
 * at the end of the fault pass. `known` lists the upstream items the target has for a failure reported after a mined
 * transfer.
 * @param {{ steps: any[], effect: { afterSettle: string, afterRetry: string, afterPass?: string } }} observed
 * @param {{ amount: string, known?: string[] }} options
 */
export function checkInvariants(observed, { amount, known = [] }) {
  const [, settle, retry] = observed.steps;
  const afterSettle = BigInt(observed.effect.afterSettle);
  const afterRetry = BigInt(observed.effect.afterRetry);
  const afterPass = BigInt(observed.effect.afterPass ?? observed.effect.afterRetry);
  const price = BigInt(amount);
  const mined = afterSettle >= price;
  const pending = settle?.errorReason === 'settlement_pending';
  const failedAfterTransfer =
    !settledNow(settle) && mined && !(pending && settle.transaction === 'present');
  const mark = (id, holds, item) => ({
    id,
    holds,
    ...(holds || item === undefined ? {} : { known: item }),
  });
  return [
    mark(
      'no-success-without-transfer',
      !(settledNow(settle) && !mined) && !(settledNow(retry) && afterRetry < price),
    ),
    mark('no-failure-after-transfer', !failedAfterTransfer, known[0]),
    mark('pending-carries-transaction', !(pending && settle.transaction !== 'present')),
    mark('moves-once', afterRetry <= price && afterPass <= price),
    mark('no-late-transfer', afterPass === afterRetry),
  ];
}

/**
 * One field of one case across results: each target's value (`unsupported` where it does not offer the scheme) and
 * whether the targets that ran it agree.
 */
export function agreement(results, caseId, step, field) {
  const values = {};
  for (const r of results) {
    const c = r.conformance.find((x) => x.case === caseId);
    if (c?.status !== 'run') {
      values[r.target.name] = 'unsupported';
      continue;
    }
    const check = c.checks.find((x) => x.field === field && x.step === step);
    values[r.target.name] = check ? check.got : 'absent';
  }
  const ran = Object.values(values).filter((v) => v !== 'unsupported');
  return { values, agree: ran.every((v) => v === ran[0]) };
}
