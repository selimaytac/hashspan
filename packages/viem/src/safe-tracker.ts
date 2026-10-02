import type { ConfirmHandle, PaymentHandle, SendHandle, TxTracker } from '@hashspan/core';
import { type Context, context, diag } from '@opentelemetry/api';

/** A send handle that records nothing; its context is `parent`, so the traced call still nests under the caller. */
export function noopSend(parent: Context): SendHandle {
  return { context: parent, end: () => {}, fail: () => {} };
}
const NOOP_CONFIRM: ConfirmHandle = { end: () => {}, timeout: () => {}, fail: () => {} };
const NOOP_PAYMENT: PaymentHandle = {
  end: () => {},
  fail: () => {},
  timeout: () => {},
  link: () => {},
};

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

function isContext(value: unknown): value is Context {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getValue?: unknown }).getValue === 'function'
  );
}

/**
 * Calls `handle[method]` with all `args` if it is a function, never throwing. Arguments are passed on as they are, so
 * every form of a handle method reaches the tracker unchanged.
 */
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
 * Wraps `tracker` so that no call into it, or into the handles it returns, can throw into the instrumented call. A
 * tracker can come from an older copy of `@hashspan/core` than this package was built with, so members added later
 * are detected and record nothing when missing. JavaScript callers can pass anything. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.5.0/docs/adr/0014-core-api-boundary.md.
 */
export function guardTracker(tracker: TxTracker): TxTracker {
  return {
    startSend: (input, parent) => {
      const caller = parent ?? context.active();
      const handle = safely(
        'start send span',
        () => tracker.startSend(input, parent),
        noopSend(caller),
      );
      if (typeof handle !== 'object' || handle === null) return noopSend(caller);
      // A tracker from a core before 0.4 has no send context: the call then runs in the caller's context.
      const sendContext = safely(
        'read the send context',
        () => {
          const value: unknown = handle.context;
          return isContext(value) ? value : caller;
        },
        caller,
      );
      return {
        context: sendContext,
        end: (...args: unknown[]) => call(handle, 'end', 'end send span', ...args),
        fail: (...args: unknown[]) => call(handle, 'fail', 'record send failure', ...args),
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
        end: (...args: unknown[]) => call(handle, 'end', 'record receipt', ...args),
        timeout: (...args: unknown[]) =>
          call(handle, 'timeout', 'record confirmation timeout', ...args),
        fail: (...args: unknown[]) => call(handle, 'fail', 'record confirmation failure', ...args),
      };
    },
    // A tracker written for an older `@hashspan/core` has no `startPayment`: it records no payment spans.
    startPayment: (input, parent) => {
      const handle = safely(
        'start payment span',
        () =>
          typeof tracker.startPayment === 'function'
            ? tracker.startPayment(input, parent)
            : NOOP_PAYMENT,
        NOOP_PAYMENT,
      );
      if (typeof handle !== 'object' || handle === null) return NOOP_PAYMENT;
      return {
        end: (...args: unknown[]) => call(handle, 'end', 'record payment settlement', ...args),
        fail: (...args: unknown[]) => call(handle, 'fail', 'record payment failure', ...args),
        timeout: (...args: unknown[]) => call(handle, 'timeout', 'record payment timeout', ...args),
        link: (...args: unknown[]) => call(handle, 'link', 'link the payment span', ...args),
      };
    },
  };
}
