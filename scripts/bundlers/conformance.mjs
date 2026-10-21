// Drives one case against a running bundler: its calls in order, each answer reduced by diff.mjs, and for a `wait` the
// receipt and the by-hash answer read until the operation is there or the target's wait ends, compared with what
// Anvil shows for it (read directly, not through the proxy).
import { chainOperation, USER_OPERATION_EVENT_TOPIC } from './chain.mjs';
import { ENTRY_POINTS } from './corpus.mjs';
import { observeAnswer, observeEstimate, observeReadBack } from './diff.mjs';

/** How long the harness waits for one answer; a bundler's own node timeout may be longer, or missing. */
export const CALL_TIMEOUT_MS = 60_000;
/** How often a `wait` reads the receipt. */
export const POLL_MS = 250;

/** POSTs one JSON-RPC call; returns the HTTP status and the parsed body, or why there was none. */
export async function rpc(url, method, params, timeoutMs = CALL_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') return { failure: 'timeout' };
    return { failure: `request failed: ${error?.cause?.code ?? error?.name}` };
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: undefined };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the receipt of `hash` until it is there or `timeoutMs` ends, then the by-hash answer and the chain; returns
 * the reduced read-back and, apart from it, the bundle transaction the chain shows (never written to a result).
 */
export async function waitFor(bundlerUrl, rpcUrl, hash, timeoutMs) {
  const started = Date.now();
  let receipt = null;
  for (;;) {
    const { body } = await rpc(bundlerUrl, 'eth_getUserOperationReceipt', [hash]);
    if (body?.result) {
      receipt = body.result;
      break;
    }
    if (Date.now() - started > timeoutMs) break;
    await sleep(POLL_MS);
  }
  const byHash = receipt
    ? (await rpc(bundlerUrl, 'eth_getUserOperationByHash', [hash])).body?.result
    : null;
  const chain = await chainOperation(rpcUrl, hash);
  return {
    observed: observeReadBack({
      userOpHash: hash,
      entryPoint: ENTRY_POINTS['0.7'],
      receipt,
      byHash,
      chain,
      topic: USER_OPERATION_EVENT_TOPIC,
    }),
    transaction: chain[0]?.transactionHash,
  };
}

/** One step of a built case on its operation. */
async function step(built, { call, op }, ctx) {
  const { hash, userOperation } = built.ops[op];
  const entryPoint = ENTRY_POINTS[built.entryPoint];
  if (call === 'estimate') {
    const { status, body, failure } = await rpc(ctx.bundlerUrl, 'eth_estimateUserOperationGas', [
      userOperation,
      entryPoint,
    ]);
    return { observed: observeEstimate(status, body, failure) };
  }
  if (call === 'send') {
    const { status, body, failure } = await rpc(ctx.bundlerUrl, 'eth_sendUserOperation', [
      userOperation,
      entryPoint,
    ]);
    const observed = observeAnswer(status, body, failure);
    // A hash other than the one the corpus computed is recorded, not taken as accepted.
    if (observed.accepted && String(body.result).toLowerCase() !== hash.toLowerCase()) {
      observed.accepted = false;
      observed.hash = 'differs';
    }
    return { observed };
  }
  if (call === 'wait') return waitFor(ctx.bundlerUrl, ctx.rpcUrl, hash, ctx.receiptTimeoutMs);
  throw new Error(`unknown call ${call}`);
}

/**
 * Runs a built case's steps; returns the observation that checkExpectations() reads. `effect.landed` names the
 * operations with a UserOperationEvent on chain, `effect.sameBundle` whether two included operations share a bundle.
 */
export async function runCase(built, ctx) {
  const steps = [];
  const transactions = [];
  for (const s of built.steps) {
    const { observed, transaction } = await step(built, s, ctx);
    steps.push({ call: s.call, op: s.op, ...observed });
    if (transaction) transactions.push(transaction);
  }
  const landed = [];
  for (const [name, { hash }] of Object.entries(built.ops)) {
    if ((await chainOperation(ctx.rpcUrl, hash)).length > 0) landed.push(name);
  }
  const effect = { landed: landed.join(',') || 'none' };
  if (transactions.length >= 2) effect.sameBundle = new Set(transactions).size === 1;
  return { steps, effect };
}

/** The UserOperationEvents of a built case's one operation, for the end of the fault pass. */
export async function eventsOf(built, rpcUrl) {
  return (await chainOperation(rpcUrl, Object.values(built.ops)[0].hash)).length;
}
