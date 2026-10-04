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

/**
 * The property descriptor `key` resolves to on `target`, own or inherited, so that it can be told apart from an
 * accessor without running one.
 */
export function descriptorOf(target: object, key: string): PropertyDescriptor | undefined {
  for (
    let object: object | null = target;
    object !== null;
    object = Object.getPrototypeOf(object)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) return descriptor;
  }
  return undefined;
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
