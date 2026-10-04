// Helpers every traced path shares: reading values, errors and the send context.
import { type Context, context, diag } from '@opentelemetry/api';
import { own } from './own.js';

// Timers without Node.js or DOM types, which src/ is type-checked without.
export const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

// The defaults of @hashspan/viem's flush() and background confirmation; test/defaults.test.ts keeps them equal.
export const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * The chain id of a call to trace: undefined, after a `diag` message, when reading the call's options throws or they
 * name no known CDP network. The call is then made untraced.
 */
export function callChainId(chainIdOf: () => number | undefined): number | undefined {
  let chainId: number | undefined;
  try {
    chainId = chainIdOf();
  } catch (error) {
    diag.error(`hashspan: failed to read the call options; call not traced (${errorName(error)})`);
    return undefined;
  }
  if (chainId === undefined)
    diag.debug('hashspan: no known CDP network in the call; not tracing it');
  return chainId;
}

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

/** `error.type` of a span whose outcome could not be read. */
export const ERROR_TYPE_OTHER = '_OTHER';

/**
 * Ends a send handle as a failure of the rejection `error`, with its CDP API error type: `fail(error, errorType)`
 * calls the handle. If the error cannot be read (a Proxy whose traps throw), the handle still ends, as a failure with
 * `error.type` `_OTHER` and without the error (ADR 0025 rule 1). Never throws.
 */
export function failSend(
  fail: (error: unknown, errorType: string | undefined) => void,
  error: unknown,
): void {
  try {
    fail(error, cdpErrorType(error));
  } catch (thrown) {
    diag.error(`hashspan: failed to record send failure (${errorName(thrown)})`);
    try {
      fail(undefined, ERROR_TYPE_OTHER);
    } catch (failure) {
      diag.error(`hashspan: failed to end the send span (${errorName(failure)})`);
    }
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

/**
 * A plain copy of the options object, with the own enumerable properties that can be read: an option whose read
 * throws gets its default, and anything but an object gives all defaults, with a `diag` warning (ADR 0025 rule 1).
 */
export function optionsOf(given: unknown): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if ((typeof given !== 'object' && typeof given !== 'function') || given === null) {
    if (given !== undefined) diag.warn('hashspan: options must be an object; using defaults');
    return options;
  }
  let keys: string[];
  try {
    keys = Object.keys(given);
  } catch {
    diag.warn('hashspan: could not read the options; using defaults');
    return options;
  }
  for (const key of keys) {
    try {
      options[key] = (given as Record<string, unknown>)[key];
    } catch {
      diag.warn(`hashspan: could not read the ${key} option; using its default`);
    }
  }
  return options;
}
