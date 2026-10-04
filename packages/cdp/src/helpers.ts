// Helpers every traced path shares: reading values, errors and the send context.
import { type Context, context, diag } from '@opentelemetry/api';
import { own } from './own.js';

// Timers without Node.js or DOM types, which src/ is type-checked without.
export const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/** The name of `error` for a `diag` message; never throws, also for an error whose name cannot be read. */
export function errorName(error: unknown): string {
  try {
    return error instanceof Error && error.name ? error.name : 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/**
 * The context a send handle's call runs in: its send context, or the caller's for a handle without a usable one, such
 * as one from a tracker of a core before 0.4 (ADR 0014).
 */
export function sendContextOf(handle: { context?: unknown } | undefined): Context {
  const caller = context.active();
  try {
    const sendContext = handle?.context;
    return typeof sendContext === 'object' &&
      sendContext !== null &&
      typeof (sendContext as { getValue?: unknown }).getValue === 'function'
      ? (sendContext as Context)
      : caller;
  } catch (error) {
    diag.debug(`hashspan: could not read the send context (${errorName(error)})`);
    return caller;
  }
}

/** The CDP API's error type (`APIError.errorType`, e.g. `insufficient_balance`), recorded as `error.type`. */
export function cdpErrorType(error: unknown): string | undefined {
  const type = error instanceof Error ? own(error, 'errorType') : undefined;
  return typeof type === 'string' ? type : undefined;
}

export function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function addressOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : stringOrUndefined(own(value, 'address'));
}
