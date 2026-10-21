// The fault scenario of one faults-proxy run, from the FAULT_SCENARIO env variable: the rules of
// `@hashspan/faults` by JSON-RPC method, as JSON. Kinds whose rule is a function (`result`) cannot come through env
// and are refused, as is anything the proxy does not know.

const KINDS = ['hang', 'http', 'rpc-error', 'reset', 'drop', 'truncate', 'previous'];

/** Checks one fault; returns it. */
function checkFault(fault, method) {
  if (fault === null || typeof fault !== 'object')
    throw new Error(`${method}: a fault is an object`);
  if (fault.kind === 'result') throw new Error(`${method}: kind result takes a function, not JSON`);
  if (!KINDS.includes(fault.kind)) throw new Error(`${method}: unknown kind ${String(fault.kind)}`);
  if (fault.kind === 'http' && !Number.isInteger(fault.status))
    throw new Error(`${method}: http needs a status`);
  if (fault.kind === 'rpc-error' && !Number.isInteger(fault.code)) {
    throw new Error(`${method}: rpc-error needs a code`);
  }
  return fault;
}

/** Checks one rule: a fault, or `{ fault, after?, times? }`. */
function checkRule(rule, method) {
  if (rule !== null && typeof rule === 'object' && 'fault' in rule) {
    checkFault(rule.fault, method);
    for (const key of ['after', 'times']) {
      if (key in rule && !(Number.isInteger(rule[key]) && rule[key] >= 0)) {
        throw new Error(`${method}: ${key} is a count`);
      }
    }
    return rule;
  }
  return checkFault(rule, method);
}

/** The rules of a FAULT_SCENARIO value; no value is no fault. */
export function parseScenario(text) {
  if (text === undefined || text === '') return {};
  let rules;
  try {
    rules = JSON.parse(text);
  } catch {
    throw new Error('FAULT_SCENARIO is not JSON');
  }
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    throw new Error('FAULT_SCENARIO is an object of rules by method');
  }
  for (const [method, rule] of Object.entries(rules)) {
    for (const one of Array.isArray(rule) ? rule : [rule]) checkRule(one, method);
  }
  return rules;
}
