// Compares what a bundler answered with the corpus: each JSON-RPC answer and each receipt read reduced to the fields
// the matrix compares, each expectation checked (`spec`) or recorded (`unspecified`), the invariants of the fault pass,
// and the values of one field across targets. Text describes what was returned or stored; a spec difference is not
// called anything else until a filing has passed the upstream gate.
import { reasonOf } from './chain.mjs';

/** The upstream items a `known:` mark may name: filed already, so a difference they describe is not new. */
export const KNOWN = ['rundler#1354'];

const LONG_HEX = /0x[0-9a-fA-F]{40,}/g;
const PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|root|private|tmp|var\/folders)\/)[^\s"',)]*/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const DATETIME = /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;
const WORD = /\bbugs?\b/i;
const MAX_TEXT = 200;

/**
 * Text a bundler returned, made safe for a result: addresses, hashes and payloads, paths, IP addresses other than
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

/** The first `AAxx` code of an error message, if it has one. */
export const aaOf = (message) => /\bAA\d\d\b/.exec(String(message ?? ''))?.[0];

/**
 * One JSON-RPC answer, reduced: `answer` is `result`, `error` (a JSON-RPC error object), `no-json-rpc` (an HTTP answer
 * without one, such as a 500 page), `timeout` or `connection` (no answer at all); then `accepted` (a hash came back),
 * the error `code`, its `AAxx` and a sanitized message. `failure` is the harness's reason when no answer came.
 * @param {number | undefined} status
 * @param {any} body
 * @param {string} [failure]
 * @returns {Record<string, any>}
 */
export function observeAnswer(status, body, failure) {
  if (failure === 'timeout') return { answer: 'timeout' };
  if (failure !== undefined) return { answer: 'connection', error: sanitize(failure) };
  const out = { status };
  if (body !== null && typeof body === 'object' && 'error' in body && body.error) {
    out.answer = 'error';
    out.accepted = false;
    if (Number.isInteger(body.error.code)) out.code = body.error.code;
    const message = typeof body.error.message === 'string' ? body.error.message : '';
    const aa = aaOf(message);
    if (aa) out.aa = aa;
    out.message = sanitize(message);
    return out;
  }
  if (body !== null && typeof body === 'object' && 'result' in body) {
    out.answer = 'result';
    out.accepted = typeof body.result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.result);
    return out;
  }
  out.answer = 'no-json-rpc';
  out.accepted = false;
  return out;
}

/** The fields an estimate states (erc-7769.md:201-207); paymasterVerificationGasLimit only with a paymaster. */
export const ESTIMATE_FIELDS = ['preVerificationGas', 'verificationGasLimit', 'callGasLimit'];

/**
 * An estimate answer, reduced: whether it has every field, never the values (they differ by bundler policy).
 * @param {number | undefined} status
 * @param {any} body
 * @param {string} [failure]
 * @returns {Record<string, any>}
 */
export function observeEstimate(status, body, failure) {
  const out = observeAnswer(status, body, failure);
  delete out.accepted;
  if (out.answer !== 'result') return out;
  const result = body.result ?? {};
  const missing = ESTIMATE_FIELDS.filter((f) => typeof result[f] !== 'string');
  out['estimate.fields'] = missing.length ? `missing: ${missing.join(', ')}` : 'complete';
  return out;
}

/** The fields of a receipt (erc-7769.md:247-260); `paymaster` may be empty and `reason` is for a reverted operation. */
export const RECEIPT_FIELDS = [
  'userOpHash',
  'entryPoint',
  'sender',
  'nonce',
  'paymaster',
  'actualGasCost',
  'actualGasUsed',
  'success',
  'logs',
  'receipt',
];

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const big = (v) => {
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
};

/** How a receipt shows `paymaster`: `zero-address`, `empty`, `absent` or `address`. */
export function paymasterForm(value) {
  if (value === undefined) return 'absent';
  if (value === null || value === '' || value === '0x') return 'empty';
  if (same(value, ZERO_ADDRESS)) return 'zero-address';
  return 'address';
}

/**
 * A receipt and a by-hash answer read until the operation was there, reduced and compared with the chain:
 * `chain` is what chain.mjs read for the hash (its UserOperationEvents), `topic` the UserOperationEvent topic. No
 * hash or value of the chain is kept, only whether they agree. A
 * receipt's `logs` are this operation's own when they are all in the bundle's receipt and none is another
 * operation's UserOperationEvent.
 * @param {{ userOpHash: string, entryPoint: string, receipt: any, byHash: any, chain: any[], topic: string,
 *   waited?: number }} read
 */
export function observeReadBack({ userOpHash, entryPoint, receipt, byHash, chain, topic, waited }) {
  /** @type {Record<string, any>} */
  const out = {
    included: receipt !== null && receipt !== undefined && typeof receipt === 'object',
  };
  if (waited !== undefined) out.waitedMs = waited;
  out['chain.events'] = chain.length;
  if (!out.included) return out;
  const missing = RECEIPT_FIELDS.filter((f) => !(f in receipt));
  out['receipt.shape'] = missing.length ? `missing: ${missing.join(', ')}` : 'complete';
  out['receipt.success'] = receipt.success;
  out['receipt.paymaster'] = paymasterForm(receipt.paymaster);
  out['receipt.reason'] = reasonOf(receipt.reason);
  const event = chain[0];
  const bundle = receipt.receipt ?? {};
  out['receipt.matchesChain'] =
    event !== undefined &&
    chain.length === 1 &&
    same(receipt.userOpHash, userOpHash) &&
    same(receipt.entryPoint, entryPoint) &&
    same(bundle.transactionHash, event.transactionHash) &&
    same(receipt.sender, event.sender) &&
    big(receipt.nonce) === event.nonce &&
    big(receipt.actualGasCost) === event.actualGasCost &&
    big(receipt.actualGasUsed) === event.actualGasUsed &&
    receipt.success === event.success;
  const bundleLogs = Array.isArray(bundle.logs) ? bundle.logs : [];
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const key = (l) => `${l.transactionHash}:${l.logIndex}`.toLowerCase();
  const inBundle = new Set(bundleLogs.map(key));
  out['receipt.logsOwn'] =
    Array.isArray(receipt.logs) &&
    logs.every((l) => inBundle.has(key(l))) &&
    !logs.some((l) => same(l.topics?.[0], topic) && !same(l.topics?.[1], userOpHash));
  out['receipt.logCount'] = logs.length;
  out['receipt.bundleReceipt'] =
    event !== undefined &&
    same(bundle.transactionHash, event.transactionHash) &&
    bundleLogs.length === event.bundleLogs
      ? 'whole-bundle'
      : 'differs';
  out['byHash.matchesChain'] =
    byHash !== null &&
    typeof byHash === 'object' &&
    event !== undefined &&
    same(byHash.transactionHash, event.transactionHash) &&
    same(byHash.blockHash, event.blockHash) &&
    big(byHash.blockNumber) === event.blockNumber &&
    same(byHash.entryPoint, entryPoint);
  return out;
}

/** The value of an expectation's field in an observation: a step's field, or an effect (`effect.sameBundle`). */
function fieldValue(observed, e) {
  if (e.field.startsWith('effect.')) return observed.effect?.[e.field.slice(7)] ?? 'absent';
  return observed.steps?.[e.step]?.[e.field] ?? 'absent';
}

/**
 * Checks a case's expectations against what was observed. A `spec` row is a `match` or a `spec-difference` (with its
 * `known` mark, when the difference is one filed upstream); an `unspecified` row is `recorded`, for the comparison
 * across targets. A row `when: 'included'` is `not-reached` when its operation was not included.
 */
export function checkExpectations(expectations, observed) {
  return expectations.map((e) => {
    if (e.known !== undefined && !KNOWN.includes(e.known)) {
      throw new Error(`known: names an upstream item of ${KNOWN.join(', ')}, not ${e.known}`);
    }
    const where = e.step === undefined ? {} : { step: e.step };
    if (e.when === 'included' && observed.steps?.[e.step]?.included !== true) {
      return {
        ...where,
        field: e.field,
        kind: e.kind,
        got: 'not-included',
        outcome: 'not-reached',
      };
    }
    const got = fieldValue(observed, e);
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

/**
 * Which EntryPoints a target can run rows of: those it lists in eth_supportedEntryPoints that have code on the chain.
 * `deployed` is keyed by the addresses as listed (any case); returns the versions, by the corpus's canonical addresses.
 */
export function usableEntryPoints(listed, deployed, entryPoints) {
  const list = Array.isArray(listed) ? listed : [];
  return Object.entries(entryPoints)
    .filter(([, address]) => {
      const entry = list.find((a) => same(a, address));
      return entry !== undefined && deployed[entry] === true;
    })
    .map(([version]) => version);
}

/** `run` when the target lists and the chain has the case's EntryPoint, else `unsupported`: shown apart. */
export const caseStatus = (c, usable) =>
  usable.includes(c.entryPoint ?? '0.7') ? 'run' : 'unsupported';

/** Counts of a target's conformance pass. */
export function summarize(conformance) {
  const checks = conformance.flatMap((c) => c.checks ?? []);
  const spec = checks.filter((c) => c.kind === 'spec' && c.outcome !== 'not-reached');
  return {
    cases: conformance.length,
    run: conformance.filter((c) => c.status === 'run').length,
    unsupported: conformance.filter((c) => c.status === 'unsupported').length,
    spec: spec.length,
    matched: spec.filter((c) => c.outcome === 'match').length,
    differences: spec.filter((c) => c.outcome === 'spec-difference' && !c.known).length,
    known: spec.filter((c) => c.outcome === 'spec-difference' && c.known).length,
    notReached: checks.filter((c) => c.outcome === 'not-reached').length,
    recorded: checks.filter((c) => c.outcome === 'recorded').length,
  };
}

/**
 * The invariants of one fault case, whose steps are FAULT_STEPS (send, wait, the retry send, wait);
 * `afterPass` is the number of UserOperationEvents of the operation at the end of the fault pass, for an inclusion
 * after the case. `exercised` is whether the faulted method was requested after the rules were armed; a scenario that
 * was not exercised says so, and its invariants are not counted as holding.
 */
export function checkInvariants(observed, { afterPass, exercised }) {
  const [send, firstWait, retry, secondWait] = observed.steps;
  const waits = [firstWait, secondWait].filter(Boolean);
  const included = afterPass >= 1;
  const reportedFailure = send?.answer === 'error' || send?.answer === 'no-json-rpc';
  const announced = retry?.accepted === true || send?.accepted === true;
  const mark = (id, holds) => ({ id, holds: exercised ? holds : null });
  return [
    mark(
      'no-receipt-without-mined-bundle',
      waits.every((w) => !w.included || w['chain.events'] >= 1),
    ),
    mark(
      'included-at-most-once',
      afterPass <= 1 && waits.every((w) => (w['chain.events'] ?? 0) <= 1),
    ),
    mark(
      'receipt-matches-chain',
      waits.every((w) => !w.included || w['receipt.matchesChain'] === true),
    ),
    mark('no-inclusion-after-reported-failure', !(reportedFailure && included && !announced)),
  ];
}

/**
 * One field of one case across results: each target's value (`unsupported` where it cannot run the case) and whether
 * the targets that ran it agree.
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
