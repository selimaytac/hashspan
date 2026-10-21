// What a node offers, asked before the flows, so a flow the node does not have is `unsupported` (kept apart from
// failures and differences) rather than a difference. A method is unsupported only when the node answers that it
// does not know it: -32601 (Method not found), or -32004 (Method not supported, which EDR returns for an unknown
// method, edr#1258). Any other answer, an error included, means the method is there. A fork feature is read from the
// genesis header: EIP-7702 needs Prague (`requestsHash`), EIP-4844 Cancun (`excessBlobGas`).

/** The codes that say a method is not there. */
export const NOT_FOUND = [-32601, -32004];

/** Whether an answer says the method does not exist. */
export const methodMissing = (answer) => NOT_FOUND.includes(answer?.error?.code);

const ZERO_HASH = `0x${'0'.repeat(64)}`;

/** The method probes: each sends one harmless call. */
export const METHOD_PROBES = {
  eth_simulateV1: [{ blockStateCalls: [{ calls: [] }] }, 'latest'],
  debug_traceTransaction: [ZERO_HASH, {}],
  eth_getBlockReceipts: ['latest'],
};

/** The probe status of each method from its answer. */
export const methodStatus = (answer) => (methodMissing(answer) ? 'unsupported' : 'supported');

/** The fork features of a genesis header. */
export function forkFeatures(genesis) {
  const has = (field) => genesis !== null && typeof genesis === 'object' && field in genesis;
  return {
    eip7702: has('requestsHash') ? 'supported' : 'unsupported',
    eip4844: has('excessBlobGas') ? 'supported' : 'unsupported',
  };
}

/** Probes a node: the methods, the fork features of its genesis header, and whether it signs for its own accounts. */
export async function probe(rpc) {
  const out = {};
  for (const [method, params] of Object.entries(METHOD_PROBES)) {
    out[method] = methodStatus(await rpc.call(method, params));
  }
  const genesis = await rpc.call('eth_getBlockByNumber', ['0x0', false]);
  Object.assign(out, forkFeatures(genesis.result));
  const accounts = await rpc.call('eth_accounts');
  out.eth_sendTransaction =
    Array.isArray(accounts.result) && accounts.result.length > 0 ? 'supported' : 'unsupported';
  return out;
}
