// The fault pass: the valid case of each scheme again, with one fault on the facilitator's send or on its receipt
// read, injected once by `@hashspan/faults`, then the same settle again as a retry. The invariants (diff.mjs) are that
// a facilitator never reports success without a mined transfer, reports no failure after one (unless it is
// `settlement_pending` with the transaction), and never moves funds twice.

/** The cases the fault pass repeats: the valid case of each scheme. */
export const FAULT_CASES = ['exact-eip3009-valid', 'exact-permit2-valid', 'upto-permit2-partial'];

/** The methods a fault is injected on: the facilitator's send and its receipt read. */
export const FAULT_METHODS = ['eth_sendRawTransaction', 'eth_getTransactionReceipt'];

/** The faults: a hang ends at the facilitator's own timeout, or at the harness's. */
export const FAULTS = [
  { kind: 'hang' },
  { kind: 'reset' },
  { kind: 'drop' },
  { kind: 'truncate' },
  { kind: 'rpc-error', code: -32603, message: 'injected by the faults proxy' },
];

/** Each scenario: one fault on one method, applied to the method's first request only. */
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
