// Handles sharing one confirm span (ADR 0007).
import type { ConfirmRegistry, SharedConfirm } from '../confirm-registry.js';

/** One handle's claim on a shared confirm span (ADR 0007). */
interface ConfirmClaim<S extends SharedConfirm> {
  shared: S;
  /** Claims the span for a receipt: true, and the span counts as ended, unless this handle or the span ended. */
  receive(): boolean;
  /** Withdraws this handle, calling `end` if it was the last one still waiting. */
  withdraw(end: () => void): void;
}

/**
 * Joins the confirm span for `hash` in `registry`, opening it with `open` for the first handle; undefined when the
 * key recently got a receipt. A receipt from any handle ends the span; a timeout or failure only ends it when it is the
 * last handle still waiting.
 */
export function joinConfirm<S extends SharedConfirm>(
  registry: ConfirmRegistry<S>,
  chainId: number,
  hash: string,
  open: () => S,
): ConfirmClaim<S> | undefined {
  const current = registry.get(chainId, hash);
  if (current === 'settled') return undefined;
  let confirm = current;
  if (!confirm) {
    confirm = open();
    registry.start(chainId, hash, confirm);
  }
  const shared = confirm;
  shared.active += 1;
  let done = false;
  return {
    shared,
    receive: () => {
      if (done || shared.ended) return false;
      done = true;
      shared.active -= 1;
      shared.ended = true;
      return true;
    },
    withdraw: (end) => {
      if (done || shared.ended) return;
      done = true;
      shared.active -= 1;
      if (shared.active > 0) return;
      shared.ended = true;
      registry.release(chainId, hash, shared);
      end();
    },
  };
}
