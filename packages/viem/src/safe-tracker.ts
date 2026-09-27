import type { ConfirmHandle, SendHandle, TxTracker } from '@hashspan/core';
import { diag } from '@opentelemetry/api';

export const NOOP_SEND: SendHandle = { end: () => {}, fail: () => {} };
const NOOP_CONFIRM: ConfirmHandle = { end: () => {}, timeout: () => {}, fail: () => {} };

/**
 * What `diag` logs for an error: its name only. viem errors carry request arguments and RPC URLs, which may
 * include addresses, calldata or API keys.
 */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Runs `fn`, logging instead of throwing. Only the error name is logged: it may come from any tracker. */
function safely<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    diag.error(`hashspan: failed to ${what} (${errorName(error)})`);
    return fallback;
  }
}

/** Calls `handle[method]` with all `args` if it is a function, never throwing. */
function call<H>(handle: H, method: keyof H, what: string, ...args: unknown[]): void {
  safely(
    what,
    () => {
      const fn = handle[method];
      if (typeof fn === 'function') fn.apply(handle, args);
    },
    undefined,
  );
}

/**
 * Wraps `tracker` so that no call into it, or into the handles it returns, can throw into the instrumented call.
 * `withHashspan()` accepts any tracker, including user-provided ones without the core's own guarantees.
 */
export function guardTracker(tracker: TxTracker): TxTracker {
  return {
    startSend: (input, parent) => {
      const handle = safely('start send span', () => tracker.startSend(input, parent), NOOP_SEND);
      if (typeof handle !== 'object' || handle === null) return NOOP_SEND;
      return {
        end: (hash, endTime) => call(handle, 'end', 'end send span', hash, endTime),
        fail: (error, endTime) => call(handle, 'fail', 'record send failure', error, endTime),
      };
    },
    startConfirm: (input, parent) => {
      const handle = safely(
        'start confirm span',
        () => tracker.startConfirm(input, parent),
        NOOP_CONFIRM,
      );
      if (typeof handle !== 'object' || handle === null) return NOOP_CONFIRM;
      return {
        end: (receipt, endTime) => call(handle, 'end', 'record receipt', receipt, endTime),
        timeout: (endTime) => call(handle, 'timeout', 'record confirmation timeout', endTime),
        fail: (error, endTime) =>
          call(handle, 'fail', 'record confirmation failure', error, endTime),
      };
    },
  };
}
