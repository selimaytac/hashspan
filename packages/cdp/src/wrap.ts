// Wrapping the SDK's objects in place: replacing a method, and marking what was wrapped.
import { diag } from '@opentelemetry/api';
import { errorName } from './helpers.js';

// Structural views of the CDP SDK objects, so that the adapter does not depend on its internal types.
export type AnyFn = (...args: never[]) => Promise<unknown>;
export interface AccountLike {
  address?: unknown;
  [key: string]: unknown;
}
export const WRAPPED: unique symbol = Symbol.for('hashspan.cdp.wrapped');

/**
 * Replaces `target[name]` with `wrap(original)`, calling the original with `target` as `this`. Returns false when
 * the method cannot be replaced, for example on a frozen object; a method replaced before is left as it is, so
 * wrapping an object again never traces a call twice. The wrapper keeps the enumerability of the original's own
 * property, and is not enumerable when the original was inherited (the SDK's methods live on its classes'
 * prototypes), so `Object.keys`, object spread and `JSON.stringify` of the object do not change. It stays bound to
 * `target`, so a method taken off the object keeps working as before.
 */
export const replace = (
  target: Record<string, unknown>,
  name: string,
  wrap: (original: AnyFn) => AnyFn,
): boolean => {
  try {
    const original = target[name];
    if (typeof original !== 'function' || WRAPPED in original) return true;
    const wrapper = wrap((original as AnyFn).bind(target));
    Object.defineProperty(wrapper, WRAPPED, { value: true });
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    // An own property that is read-only or an accessor is left as its owner made it.
    if (descriptor !== undefined && descriptor.writable !== true) return false;
    Object.defineProperty(target, name, {
      value: wrapper,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
      configurable: descriptor?.configurable ?? true,
    });
    return target[name] === wrapper;
  } catch (error) {
    diag.error(`hashspan: failed to wrap ${name} (${errorName(error)})`);
    return false;
  }
};

/** Logs a failure to wrap a value the SDK returned; the value is then returned as it is. */
export const wrapFailed = (error: unknown): void => {
  diag.error(`hashspan: failed to wrap a CDP result (${errorName(error)})`);
};
