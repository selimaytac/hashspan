// What every handle shares: never throwing, the options of its methods and the `error.type` of a failure.
import { diag, type TimeInput } from '@opentelemetry/api';
import { ERROR_TYPE_VALUE_OTHER } from '../attributes.js';
import type { FailOptions } from '../types.js';

/** `error.type` of a wait that gave up: a confirmation or a payment whose outcome was never learned. */
export const OBSERVER_TIMEOUT = 'timeout';

/** Runs `fn`, logging instead of throwing: instrumentation must never break the caller. */
export function safely<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    diag.error(`hashspan: failed to ${what}`, error);
    return fallback;
  }
}

export function errorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : ERROR_TYPE_VALUE_OTHER;
}

const ERROR_TYPE_OVERRIDE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `value` if it is a short identifier, the only kind of free text recorded from a remote party. */
export function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && ERROR_TYPE_OVERRIDE.test(value) ? value : undefined;
}

/** A finite number, an `HrTime` pair or a `Date`: what the deprecated positional `endTime` argument takes. */
function isTimeInput(value: unknown): value is TimeInput {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number';
  }
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** The options a handle method was called with, read once. */
export interface HandleOptions {
  endTime?: TimeInput | undefined;
  errorType?: unknown;
}

/**
 * Reads the options of a handle method called as `(what, options?)` or, deprecated, as `(what, endTime?, options?)`
 * (ADR 0014). A positional end time wins over `options.endTime`. Never throws: an argument of neither form, or an
 * end time that is not one, is ignored.
 */
export function handleOptions(second: unknown, third?: unknown): HandleOptions {
  try {
    const positional = isTimeInput(second) ? second : undefined;
    const given = positional !== undefined || second === undefined ? third : (second as unknown);
    if (
      given !== undefined &&
      (typeof given !== 'object' || given === null || isTimeInput(given))
    ) {
      diag.debug('hashspan: ignoring a handle argument that is neither options nor an end time');
      return positional !== undefined ? { endTime: positional } : {};
    }
    const options = given as FailOptions | undefined;
    const endTime: unknown = positional ?? options?.endTime;
    if (endTime !== undefined && !isTimeInput(endTime)) {
      diag.debug('hashspan: ignoring an end time that is not a TimeInput');
    }
    return {
      endTime: isTimeInput(endTime) ? endTime : undefined,
      errorType: options?.errorType,
    };
  } catch (error) {
    diag.debug(`hashspan: could not read handle options (${errorType(error)})`);
    return {};
  }
}

/** The `error.type` for a failure: an adapter's override when it is a short identifier, else the class name. */
export function reportedErrorType(error: unknown, options: HandleOptions | undefined): string {
  const override = options?.errorType;
  if (override === undefined) return errorType(error);
  if (typeof override === 'string' && ERROR_TYPE_OVERRIDE.test(override)) return override;
  diag.debug('hashspan: ignoring an error type that is not a short identifier');
  return errorType(error);
}
