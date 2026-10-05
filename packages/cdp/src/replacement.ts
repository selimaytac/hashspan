// Replacements viem reports on a network-scoped account's wait, which runs on the SDK's own viem client: the same
// capture as in @hashspan/viem (docs/adr/0008-replaced-transactions.md), kept here because those helpers are internal.
import { own } from './own.js';

/** What viem reported through `onReplaced`, once it did. */
export interface ReplacementCapture {
  replacement?: unknown;
}

/**
 * An `onReplaced` that stores viem's report first, then calls the caller's own `onReplaced` with it as viem would: a
 * value that is not a function throws there, as it does in viem.
 */
export function capturing(
  capture: ReplacementCapture,
  onReplaced: unknown,
): (replacement: unknown) => void {
  return (replacement) => {
    capture.replacement = replacement;
    if (onReplaced !== undefined && onReplaced !== null) {
      (onReplaced as (replacement: unknown) => void)(replacement);
    }
  };
}

/** The receipt and reason of the replacement in `capture`, if viem reported one. */
export function reportedReplacement(
  capture: ReplacementCapture,
): { receipt: unknown; reason: unknown } | undefined {
  const { replacement } = capture;
  if (replacement === undefined) return undefined;
  return { receipt: own(replacement, 'transactionReceipt'), reason: own(replacement, 'reason') };
}

/** Case-insensitive equality of two hex strings; false unless both are strings. */
export function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Most objects of a prototype chain that {@link descriptorOf} reads; a longer chain is not read. */
const MAX_PROTOTYPE_STEPS = 64;

/**
 * The property descriptor `key` resolves to on `target`, own or inherited, so that it can be told apart from an
 * accessor without running one. Throws for a chain longer than `MAX_PROTOTYPE_STEPS`, as for options that cannot be
 * read.
 */
export function descriptorOf(target: object, key: string): PropertyDescriptor | undefined {
  let object: object | null = target;
  for (let step = 0; object !== null; step++) {
    if (step === MAX_PROTOTYPE_STEPS) throw new RangeError('prototype chain too long');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) return descriptor;
    object = Object.getPrototypeOf(object);
  }
  return undefined;
}

/**
 * True for a plain object: one whose prototype is `Object.prototype` or `null`. Only such options are shadowed: the
 * getters of a class instance's prototype would run with the shadow as `this`, where its private fields are missing.
 */
export function isPlainObject(target: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(target);
  return prototype === Object.prototype || prototype === null;
}

/** An object that reads like `target` with `key` set to `value`; `target` is left unchanged. */
export function shadowing<T extends object>(target: T, key: string, value: unknown): T {
  const descriptors = Object.getOwnPropertyDescriptors(target) as PropertyDescriptorMap;
  delete descriptors[key];
  return Object.create(target, {
    ...descriptors,
    [key]: { value, enumerable: true, writable: true, configurable: true },
  }) as T;
}
