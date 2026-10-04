// Reading the user's call arguments for telemetry: own data properties only, so no getter of the user's runs.
import type { SendInput } from '@hashspan/core';
import type { Abi } from 'viem';

export function selectorOf(data: string | undefined): string | undefined {
  return data && data.length >= 10 ? data.slice(0, 10) : undefined;
}

/**
 * The value of `target`'s own data property `key`, or undefined for an accessor, an inherited or a missing
 * property. Telemetry reads the user's call arguments only this way, so it never runs a getter: a getter with side
 * effects, or one that returns a different value per read, would otherwise change what the call sends. A Proxy's
 * `getOwnPropertyDescriptor` trap still runs.
 */
export function own(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function'))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * The EIP-7702 authorization list of a call, as the core reads it: each entry's delegated address and chain id, read
 * from own data properties. viem names the address `address`; releases before 2.23 named it `contractAddress`.
 * Signatures and nonces are left out, so they never reach telemetry.
 */
export function authorizationsOf(list: unknown): SendInput['authorizations'] {
  if (!Array.isArray(list)) return undefined;
  const length = own(list, 'length');
  if (typeof length !== 'number' || length === 0) return undefined;
  const entries: { address: string; chainId: number }[] = [];
  for (let index = 0; index < Math.min(length, MAX_AUTHORIZATIONS); index++) {
    const entry = own(list, String(index));
    const address = own(entry, 'address') ?? own(entry, 'contractAddress');
    // An entry the core cannot read keeps its place in the count.
    entries.push({ address: address as string, chainId: own(entry, 'chainId') as number });
  }
  // The core counts the whole list but reads only its first entries: the rest stay holes, never read or allocated.
  entries.length = length;
  return entries;
}

/** Most authorizations read from a list, as many as the core records. */
const MAX_AUTHORIZATIONS = 64;

export const MAX_ARGUMENTS_COPY_DEPTH = 8;
/** Most values copied from the arguments of an overloaded function, to tell its overloads apart. */
export const MAX_ARGUMENTS_COPY_VALUES = 100_000;
// Deep enough for nested tuples, which add two levels each.
const MAX_ABI_COPY_DEPTH = 32;
/** Most items of an ABI read, and values copied from them; a longer ABI is not used for telemetry. */
const MAX_ABI_ITEMS = 10_000;
const MAX_ABI_COPY_VALUES = 100_000;

/** How many more values a copy may make; one that would make more throws {@link CopyLimitReached}. */
export interface CopyBudget {
  left: number;
}

export class CopyLimitReached extends Error {}

function spend(budget: CopyBudget, values: number): void {
  budget.left -= values;
  if (budget.left < 0) throw new CopyLimitReached('copy limit reached');
}

/**
 * A copy of `value` made of own data properties only, for code that reads it deeply (viem's ABI matching);
 * accessors become undefined and nothing deeper than `maxDepth` is copied. It throws {@link CopyLimitReached}
 * before copying more values than `budget` allows, so the copy of a wide or sparse value stays bounded.
 */
export function dataOnly(
  value: unknown,
  maxDepth: number,
  budget: CopyBudget = { left: Number.POSITIVE_INFINITY },
  depth = 0,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return undefined;
  if (Array.isArray(value)) {
    const length = own(value, 'length');
    const count = typeof length === 'number' ? length : 0;
    spend(budget, count + 1);
    return Array.from({ length: count }, (_, i) =>
      dataOnly(own(value, String(i)), maxDepth, budget, depth + 1),
    );
  }
  const keys = Object.keys(value);
  spend(budget, keys.length + 1);
  const copy: Record<string, unknown> = {};
  for (const key of keys) copy[key] = dataOnly(own(value, key), maxDepth, budget, depth + 1);
  return copy;
}

/**
 * Copies made by {@link abiForTelemetry}, per ABI array and function name: a contract called many times is copied
 * once, and the transactions it sends share that copy instead of each holding one of their own. Later changes to the
 * caller's array are not seen; ABIs are written once.
 */
const abiCopies = new WeakMap<object, Map<string, Abi | undefined>>();
/** Function names cached per ABI; calls naming more functions of one ABI are copied each time. */
const MAX_COPIES_PER_ABI = 64;

/**
 * The ABI items telemetry needs, copied without accessors: the functions named `functionName`, for the selector,
 * and the errors, to decode revert reasons. viem gets this copy, never the caller's ABI, so no getter in it runs.
 */
export function abiForTelemetry(abi: unknown, functionName: unknown): Abi | undefined {
  if (!Array.isArray(abi)) return undefined;
  if (typeof functionName !== 'string') return copyAbi(abi, functionName);
  let copies = abiCopies.get(abi);
  if (copies?.has(functionName)) return copies.get(functionName);
  const copy = copyAbi(abi, functionName);
  if (!copies) {
    copies = new Map();
    abiCopies.set(abi, copies);
  }
  if (copies.size < MAX_COPIES_PER_ABI) copies.set(functionName, copy);
  return copy;
}

function copyAbi(abi: unknown[], functionName: unknown): Abi | undefined {
  const length = own(abi, 'length');
  const count = typeof length === 'number' ? length : 0;
  if (count > MAX_ABI_ITEMS) return undefined;
  const budget: CopyBudget = { left: MAX_ABI_COPY_VALUES };
  const items: unknown[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const item = own(abi, String(i));
      const type = own(item, 'type');
      if (type === 'error' || (type === 'function' && own(item, 'name') === functionName)) {
        items.push(dataOnly(item, MAX_ABI_COPY_DEPTH, budget));
      }
    }
  } catch (error) {
    if (error instanceof CopyLimitReached) return undefined;
    throw error;
  }
  return items as Abi;
}

/** The descriptor of `key` on `target` or the first prototype that has it; reading it runs no getter. */
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

/**
 * `target` with `key` shadowed by `value`: an object whose prototype is `target`, so inherited properties read through,
 * that also carries `target`'s own properties as they are (data as data, accessors as accessors, so no getter runs).
 * This works for frozen objects, keeps the number of times a getter runs, and keeps the own properties for code that
 * copies the options with a spread, such as another extension applied before this one.
 */
export function shadowing<T extends object>(target: T, key: string, value: unknown): T {
  const descriptors = Object.getOwnPropertyDescriptors(target) as PropertyDescriptorMap;
  delete descriptors[key];
  return Object.create(target, {
    ...descriptors,
    [key]: { value, enumerable: true, writable: true, configurable: true },
  }) as T;
}

export function addressOf(account: unknown): string | undefined {
  if (typeof account === 'string') return account;
  const address = own(account, 'address');
  return typeof address === 'string' ? address : undefined;
}
