// The fault pass: the plain operation again, for an account of its own per scenario, with one fault on one of the
// bundler's node methods, armed once the bundler is ready and applied to the method's first request after that. The
// case estimates, sends, waits for the receipt, sends the same operation again as a retry and waits again. The
// invariants (diff.mjs) are that no operation is reported included without a mined bundle, none is included twice, a
// receipt agrees with the chain, and a reported failure is not followed by an inclusion the retry did not announce.

/** The case the fault pass repeats. */
export const FAULT_CASE = 'plain-op';

/** The calls of a fault case, on its one operation. */
export const FAULT_STEPS = ['estimate', 'send', 'wait', 'send', 'wait'];

/** Where the fault pass moves each account's salt, so it never shares a sender with the conformance pass. */
export const FAULT_SALT_BASE = 1000;

/**
 * The methods a fault is injected on: the bundle send, the gas estimate of a bundle or of an operation, the receipt
 * read of the bundle, and the simulation calls.
 */
export const FAULT_METHODS = [
  'eth_sendRawTransaction',
  'eth_estimateGas',
  'eth_getTransactionReceipt',
  'eth_call',
];

/** The faults: a hang ends at the bundler's own timeout, or at the harness's. */
export const FAULTS = [
  { kind: 'hang' },
  { kind: 'reset' },
  { kind: 'drop' },
  { kind: 'truncate' },
  { kind: 'rpc-error', code: -32603, message: 'injected by the faults proxy' },
];

/** Each scenario: one fault on one method, applied to the first request of that method after arming. */
export function faultScenarios() {
  return FAULT_METHODS.flatMap((method) =>
    FAULTS.map((fault) => ({
      id: `${method}:${fault.kind}`,
      method,
      fault,
      rules: { [method]: { fault, times: 1 } },
    })),
  );
}
