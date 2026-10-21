// Drives one case against a running facilitator: its calls in order (/verify always first, as the TypeScript
// facilitator settles only a verified payment), each answer reduced by observeCall(), and what moved on chain between
// the first call and the last, read from Anvil directly rather than through the proxy.
import { balanceOf, moved, readBalances } from './chain.mjs';
import { bodyOf } from './corpus.mjs';
import { observeCall } from './diff.mjs';

/**
 * How long the harness waits for a verify answer, and for a settle when the run gives no target wait; a settle waits
 * the target's own receipt wait plus a margin (settleTimeoutOf() in targets.mjs).
 */
export const CALL_TIMEOUT_MS = 120_000;

/** POSTs one call and reduces the answer. */
export async function call(facilitatorUrl, path, body, timeoutMs = CALL_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(`${facilitatorUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') return observeCall(undefined, undefined, 'timeout', path);
    return observeCall(
      undefined,
      undefined,
      `request failed: ${error?.cause?.code ?? error?.name}`,
      path,
    );
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return observeCall(response.status, undefined, text, path);
  }
  return observeCall(response.status, parsed, undefined, path);
}

/** Runs a built case's calls; returns the observation that checkExpectations() reads. */
export async function runCase(
  built,
  { facilitatorUrl, rpcUrl, settleTimeoutMs = CALL_TIMEOUT_MS },
) {
  const before = await readBalances(rpcUrl);
  const steps = [];
  for (const path of built.steps) {
    const timeout = path === 'settle' ? settleTimeoutMs : CALL_TIMEOUT_MS;
    steps.push(await call(facilitatorUrl, path, bodyOf(built, path), timeout));
  }
  const after = await readBalances(rpcUrl);
  return { steps, effect: moved(before, after) };
}

/**
 * Runs a built case as a fault case: verify, the faulted settle, then the same settle again as a retry, reading what
 * reached the case's own receiver (it starts at 0) after each settle. The run reads it once more at the end of the
 * pass (`afterPass`), for a transfer that mined after the case.
 */
export async function runFaultCase(
  built,
  { facilitatorUrl, rpcUrl, settleTimeoutMs = CALL_TIMEOUT_MS },
) {
  const receiver = built.paymentRequirements.payTo;
  const settle = bodyOf(built, 'settle');
  const steps = [await call(facilitatorUrl, 'verify', bodyOf(built, 'verify'))];
  steps.push(await call(facilitatorUrl, 'settle', settle, settleTimeoutMs));
  const afterSettle = await balanceOf(rpcUrl, receiver);
  steps.push(await call(facilitatorUrl, 'settle', settle, settleTimeoutMs));
  const afterRetry = await balanceOf(rpcUrl, receiver);
  return { steps, effect: { afterSettle, afterRetry } };
}
