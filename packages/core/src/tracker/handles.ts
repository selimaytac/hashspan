// What every handle shares: never throwing, the options of its methods and the `error.type` of a failure.
import { type Context, diag, type TimeInput } from '@opentelemetry/api';
import { ERROR_TYPE_VALUE_OTHER } from '../attributes.js';
import type {
  CallBatchConfirmHandle,
  CallBatchSendHandle,
  ConfirmHandle,
  FailOptions,
  SendHandle,
  UserOperationConfirmHandle,
  UserOperationSendHandle,
} from '../types.js';
import { identifier } from './values.js';

/** `error.type` of a wait that gave up: a confirmation or a payment whose outcome was never learned. */
export const OBSERVER_TIMEOUT = 'timeout';

/**
 * A send handle of any kind that records nothing; its context is the parent, so a call run in it still nests under
 * the caller.
 */
export const noopSend = (
  parent: Context,
): SendHandle & UserOperationSendHandle & CallBatchSendHandle => ({
  context: parent,
  end: () => {},
  fail: () => {},
});

/** A confirm handle of any kind that records nothing. */
export const NOOP_CONFIRM: ConfirmHandle & UserOperationConfirmHandle & CallBatchConfirmHandle = {
  end: () => {},
  timeout: () => {},
  fail: () => {},
};

/** Runs `fn`, logging instead of throwing: instrumentation must never break the caller. */
export function safely<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    diag.error(`hashspan: failed to ${what}`, error);
    return fallback;
  }
}

/**
 * The class name of `error` if it is a short identifier, else `_OTHER`: an error's name is free text from any library
 * or remote party, so a long or odd one is not recorded (ADR 0025). Never throws, also for a name getter that does.
 */
export function errorType(error: unknown): string {
  try {
    return (error instanceof Error && identifier(error.name)) || ERROR_TYPE_VALUE_OTHER;
  } catch {
    return ERROR_TYPE_VALUE_OTHER;
  }
}

/** A finite number, an `HrTime` pair or a `Date`: what `endTime` takes. */
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
 * Reads the options of a handle method called as `(what, options?)` (ADR 0014). Never throws: an argument that is
 * not an options object, such as the positional end time that 1.0 removed, or an end time that is not one, is
 * ignored.
 */
export function handleOptions(given: unknown): HandleOptions {
  try {
    if (
      given !== undefined &&
      (typeof given !== 'object' || given === null || isTimeInput(given))
    ) {
      diag.debug('hashspan: ignoring a handle argument that is not an options object');
      return {};
    }
    const options = given as FailOptions | undefined;
    const endTime: unknown = options?.endTime;
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
  const kept = identifier(override);
  if (kept !== undefined) return kept;
  diag.debug('hashspan: ignoring an error type that is not a short identifier');
  return errorType(error);
}
