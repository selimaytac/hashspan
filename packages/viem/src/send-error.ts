// `error.type` of a failed send: the error viem classified the failure as, under the errors it wraps it in.
import type { FailOptions } from '@hashspan/core';
import { own } from './arguments.js';

/**
 * viem's errors that carry the reason a send failed as their `cause`: `sendTransaction` wraps the error it classified
 * (such as `NonceTooLowError`) in a `TransactionExecutionError`, `writeContract` that again in a
 * `ContractFunctionExecutionError`, and `sendUserOperation` the bundler's error in a `UserOperationExecutionError`.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'ContractFunctionExecutionError',
  'TransactionExecutionError',
  'EstimateGasExecutionError',
  'UserOperationExecutionError',
]);

/** Most `cause` links followed; a longer or cyclic chain keeps the thrown error's class. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The name of the first error under viem's wrappers in the `cause` chain of `error`, such as `NonceTooLowError`, or
 * undefined when `error` is not one of them or no named error is found under them, so that the thrown error's class
 * is recorded. Reads `name` and `cause` as own data properties only, so no getter runs. Never throws.
 */
export function classifiedErrorName(error: unknown): string | undefined {
  try {
    let current = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
      const name = own(current, 'name');
      if (typeof name !== 'string') return undefined;
      if (!WRAPPERS.has(name)) return depth === 0 ? undefined : name;
      current = own(current, 'cause');
    }
  } catch {
    // A chain that cannot be read keeps the thrown error's class.
  }
  return undefined;
}

/** The options of a send handle's `fail` for `error`: its end time, and the classified error as `error.type`. */
export function sendFailure(error: unknown, endTime?: Date): FailOptions {
  const errorType = classifiedErrorName(error);
  return {
    ...(endTime !== undefined ? { endTime } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
  };
}
