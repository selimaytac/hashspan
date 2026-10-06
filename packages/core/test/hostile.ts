// The hostile-input table of ADR 0025: values that untrusted sources can hand to telemetry, and the checks every
// public entry point must pass with them. Imported by each package's `test/hostile-input.test.ts` by relative path.
// It depends on no source module, so it stays valid while the sources move.
import { appendFileSync } from 'node:fs';
import {
  type Attributes,
  context,
  type Histogram,
  type MeterProvider,
  propagation,
  trace,
} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { metricViolations } from './conformance.js';

/** An address whose 40 hex characters must never appear in `off` or `hashed` address mode. */
export const ADDRESS = '0x2222222222222222222222222222222222222222';
export const ADDRESS_HEX = ADDRESS.slice(2);
export const OTHER_ADDRESS = '0x4444444444444444444444444444444444444444';
export const HASH = `0x${'ab'.repeat(32)}`;
/** A credential in a URL, as an RPC provider's API key appears in error messages. */
export const SECRET = 'k3y5ecret0000';
export const SECRET_URL = `https://rpc.example.com/v2/${SECRET}?apikey=${SECRET}`;

/**
 * The documented bounds (docs/semconv.md, "Bounds"), as numbers here on purpose: a test that imported them from the
 * sources would follow a changed bound instead of catching it.
 */
export const BOUNDS = {
  revertReason: 1024,
  sanitizedMessage: 256,
  functionArguments: 4096,
  functionArgumentsDepth: 32,
  authorizations: 64,
  callBatchTransactionHashes: 64,
  callBatchId: 256,
  x402Resource: 512,
  openX402Payments: 1000,
} as const;
/** What a cut value ends with. */
export const ELLIPSIS = '...';
/**
 * Ceiling for a string attribute without a documented bound of its own: the longest documented bound, plus the
 * ellipsis. An attribute longer than this is unbounded.
 */
export const GENERIC_MAX_LENGTH = BOUNDS.functionArguments + ELLIPSIS.length;
/** Ceiling for an array attribute without a documented bound of its own. */
export const GENERIC_MAX_ITEMS = 64;

/** Thrown by hostile values, so a test can tell their errors from others. */
export class HostileError extends Error {
  override name = 'HostileError';
}

const fail = (trap: string) => (): never => {
  throw new HostileError(`hostile ${trap} trap`);
};

/** A Proxy every trap of which throws, around `target` (a function target also traps calls). */
export function throwingProxy<T extends object>(target: T = {} as T): T {
  return new Proxy(target, {
    get: fail('get'),
    set: fail('set'),
    has: fail('has'),
    deleteProperty: fail('deleteProperty'),
    ownKeys: fail('ownKeys'),
    getOwnPropertyDescriptor: fail('getOwnPropertyDescriptor'),
    defineProperty: fail('defineProperty'),
    getPrototypeOf: fail('getPrototypeOf'),
    setPrototypeOf: fail('setPrototypeOf'),
    isExtensible: fail('isExtensible'),
    preventExtensions: fail('preventExtensions'),
    apply: fail('apply'),
    construct: fail('construct'),
  });
}

/** A revoked Proxy: every operation on it throws a TypeError, even `Array.isArray` for an array target. */
export function revokedProxy<T extends object>(target: T = {} as T): T {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

export interface Counted<T> {
  value: T;
  /** How many times any of its getters ran. */
  reads(): number;
}

/** `values` with each own key turned into an enumerable getter that counts its reads and returns the value. */
export function countingGetters<T extends object>(values: T): Counted<T> {
  let reads = 0;
  const value = {} as T;
  for (const [key, item] of Object.entries(values)) {
    Object.defineProperty(value, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads++;
        return item;
      },
    });
  }
  return { value, reads: () => reads };
}

/** An object whose `keys` are enumerable getters that throw. */
export function throwingGetters(keys: readonly string[]): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(value, key, { enumerable: true, get: fail(`${key} getter`) });
  }
  return value;
}

/** Names of `Object.prototype` members, which a lookup by name must not find. */
export const PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
] as const;

/** An object with `entries` as own data properties, also `__proto__`, which a literal would make the prototype. */
export function withOwnKeys(entries: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(entries)) {
    Object.defineProperty(value, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return value;
}

/** An object with every `Object.prototype` name as an own key holding `item`. */
export function prototypeKeyed(item: unknown): Record<string, unknown> {
  return withOwnKeys(Object.fromEntries(PROTOTYPE_NAMES.map((name) => [name, item])));
}

export interface Budgeted<T> {
  value: T[];
  /** How many index reads it served, however they were made (`get`, `has`, `getOwnPropertyDescriptor`). */
  reads(): number;
}

/**
 * `items` behind a Proxy that counts index reads and throws once more than `budget` were made, so that a list read in
 * full fails fast instead of hanging a test. `Array.isArray` is true for it.
 */
export function budgeted<T>(items: T[], budget = 10_000): Budgeted<T> {
  let reads = 0;
  const isIndex = (key: string | symbol): boolean => typeof key === 'string' && /^\d+$/.test(key);
  const count = (key: string | symbol): void => {
    if (!isIndex(key)) return;
    reads++;
    if (reads > budget) throw new HostileError(`read more than ${budget} items`);
  };
  const value = new Proxy(items, {
    get(target, key, receiver) {
      count(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      count(key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      count(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { value, reads: () => reads };
}

/** A sparse array of the largest length, holding `first` at index 0 only. */
export function hugeSparse<T>(first?: T): T[] {
  const items: T[] = [];
  items.length = 2 ** 32 - 1;
  if (first !== undefined) items[0] = first;
  return items;
}

/** A dense array of `length` copies of `item`. */
export function dense<T>(item: T, length = 100_000): T[] {
  return Array.from({ length }, () => item);
}

/** `length` characters of `fill`. */
export function long(length = 1_000_000, fill = 'x'): string {
  return fill.repeat(Math.ceil(length / fill.length)).slice(0, length);
}

/** Strings one below, at and one above `bound` characters. */
export function aroundBound(bound: number): [string, string][] {
  return [
    [`${bound - 1} characters`, long(bound - 1)],
    [`${bound} characters`, long(bound)],
    [`${bound + 1} characters`, long(bound + 1)],
  ];
}

/**
 * Text with {@link ADDRESS} starting `before` characters before the cut at `bound`, so the cut splits it, with
 * `prefix` first (for example a URL scheme).
 */
export function addressAcrossCut(bound: number, prefix = '', before = 10): string {
  return `${prefix}${long(bound - prefix.length - before)}${ADDRESS}${long(50)}`;
}

/** Whether `value` ends in a cut that split a hex value: `0x` and fewer hex digits than an address, then `...`. */
export function splitsHex(value: string): boolean {
  const match = /0[xX]([0-9a-fA-F]*)\.\.\.$/.exec(value);
  return match !== null && (match[1] as string).length < 40;
}

/** Hashes that are not 32-byte `0x` hex. */
export const MALFORMED_HASHES: readonly (readonly [string, string])[] = [
  ['0x only', '0x'],
  ['odd length', `0x${'ab'.repeat(32)}a`],
  ['one byte short', `0x${'ab'.repeat(31)}`],
  ['one byte long', `0x${'ab'.repeat(33)}`],
  ['non-hex', `0x${'zz'.repeat(32)}`],
  ['no prefix', 'ab'.repeat(32)],
  ['leading space', ` 0x${'ab'.repeat(32)}`],
  ['trailing newline', `0x${'ab'.repeat(32)}\n`],
];
/** Addresses that are not 20-byte `0x` hex. */
export const MALFORMED_ADDRESSES: readonly (readonly [string, string])[] = [
  ['0x only', '0x'],
  ['odd length', `${ADDRESS}2`],
  ['one byte short', ADDRESS.slice(0, -2)],
  ['non-hex', `0x${'zz'.repeat(20)}`],
  ['no prefix', ADDRESS_HEX],
  ['trailing newline', `${ADDRESS}\n`],
];
/** Valid in any letter case, and recorded in lower case where the address mode applies. */
export const MIXED_CASE_HASH = `0x${'aB'.repeat(32)}`;
export const MIXED_CASE_ADDRESS = `0x${'aB'.repeat(20)}`;

/** Numbers that are not positive safe integers, and bigints where a number is expected. */
export const OUT_OF_RANGE: readonly (readonly [string, unknown])[] = [
  ['-1', -1],
  ['0', 0],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['2**53 + 1', 2 ** 53 + 1],
  ['1.5', 1.5],
  ['-1n', -1n],
  ['2n ** 256n', 2n ** 256n],
  ['1n where a number is expected', 1n],
];

/** Values of the wrong type for any field. */
export const WRONG_TYPES: readonly (readonly [string, unknown])[] = [
  ['null', null],
  ['undefined', undefined],
  ['a symbol', Symbol('hostile')],
  ['a function', () => 1],
  ['true', true],
  ['an empty object', {}],
  ['an empty array', []],
  ['a numeric string', '1'],
  ['an empty string', ''],
];

/**
 * Every hostile value, built fresh for each call so that read counters and Proxies start unused: what an untrusted
 * field can hold.
 */
export function hostileValues(): [string, unknown][] {
  return [
    ['a throwing Proxy', throwingProxy()],
    ['a throwing Proxy around an array', throwingProxy([])],
    ['a revoked Proxy', revokedProxy()],
    ['a revoked Proxy around an array', revokedProxy([])],
    ['an object with throwing getters', throwingGetters(['hash', 'id', 'status', 'name'])],
    ...PROTOTYPE_NAMES.map((name): [string, unknown] => [`the name ${name}`, name]),
    ['an object with Object.prototype keys', prototypeKeyed(HASH)],
    ['a sparse array of length 2**32 - 1', budgeted(hugeSparse(HASH)).value],
    ['a dense array of 100 000 items', budgeted(dense(HASH)).value],
    ['a string of a million characters', long()],
    ...MALFORMED_HASHES.map(([label, value]): [string, unknown] => [`a hash: ${label}`, value]),
    ...OUT_OF_RANGE.map(([label, value]): [string, unknown] => [label, value]),
    ...WRONG_TYPES.map(([label, value]): [string, unknown] => [label, value]),
  ];
}

/** Errors as libraries, wallets and remote parties throw them, or worse. */
export function hostileErrors(): [string, unknown][] {
  const nameGetter = new Error('boom');
  Object.defineProperty(nameGetter, 'name', { get: fail('name getter') });
  const messageGetter = new Error();
  Object.defineProperty(messageGetter, 'message', { get: fail('message getter') });
  const longName = new Error('boom');
  longName.name = long();
  const addressName = new Error('boom');
  addressName.name = `Error${ADDRESS}`;
  const prototypeName = new Error('boom');
  prototypeName.name = 'constructor';
  const secretMessage = new Error(
    `request to ${SECRET_URL} failed for ${ADDRESS}\nsecond line ${SECRET}`,
  );
  const longMessage = new Error(long());
  const cutMessage = new Error(addressAcrossCut(BOUNDS.sanitizedMessage));
  const symbolName = new Error('boom');
  Object.defineProperty(symbolName, 'name', { value: Symbol('name') });
  return [
    ['a throwing Proxy', throwingProxy()],
    ['a throwing Proxy around an Error', throwingProxy(new Error('boom'))],
    ['a revoked Proxy', revokedProxy()],
    ['an Error whose name getter throws', nameGetter],
    ['an Error whose message getter throws', messageGetter],
    ['an Error named with a million characters', longName],
    ['an Error named after an address', addressName],
    ['an Error named constructor', prototypeName],
    ['an Error whose name is a symbol', symbolName],
    ['an Error with a URL, an address and a second line', secretMessage],
    ['an Error with a message of a million characters', longMessage],
    ['an Error with an address across the message bound', cutMessage],
    ['a string', `thrown ${ADDRESS}`],
    ...WRONG_TYPES.map(([label, value]): [string, unknown] => [label, value]),
  ];
}

// --- Tracing and metrics ---------------------------------------------------------------------------------------

export interface HostileTracing {
  spans(): ReadableSpan[];
  /** Spans started and not ended yet. */
  open(): number;
  reset(): void;
  teardown(): Promise<void>;
}

/** Registers a global tracer provider that keeps finished spans and counts open ones. */
export function setupHostileTracing(): HostileTracing {
  const exporter = new InMemorySpanExporter();
  const live = new Set<Span>();
  const counter: SpanProcessor = {
    onStart: (span) => {
      live.add(span);
    },
    onEnd: (span) => {
      live.delete(span as unknown as Span);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = new NodeTracerProvider({
    spanProcessors: [counter, new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return {
    spans: () => exporter.getFinishedSpans(),
    open: () => live.size,
    reset: () => {
      exporter.reset();
      live.clear();
    },
    teardown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

export interface MetricSample {
  name: string;
  value: number;
  attributes: Attributes;
}

/** A meter provider that keeps every histogram sample, for the `meterProvider` option. */
export function recordingMeterProvider(): {
  provider: MeterProvider;
  samples(): MetricSample[];
  reset(): void;
} {
  const samples: MetricSample[] = [];
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => ({
        record: (value: number, attributes: Attributes = {}) => {
          samples.push({ name, value, attributes });
        },
      }),
    }),
  } as unknown as MeterProvider;
  return { provider, samples: () => [...samples], reset: () => void samples.splice(0) };
}

// --- Rules 3 to 6: what may be recorded --------------------------------------------------------------------------

export type AddressMode = 'raw' | 'hashed' | 'off';
export type ErrorMessageMode = 'off' | 'sanitized' | 'raw';

export interface RecordingModes {
  address?: AddressMode;
  errorMessages?: ErrorMessageMode;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const CALL_BATCH_ID = /^0x[0-9a-fA-F]{1,256}$/;
const SOLIDITY_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/;

type Check = (value: unknown, modes: Required<RecordingModes>) => string | undefined;

const isSafeCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isChainId = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const oneOf =
  (...allowed: unknown[]): Check =>
  (value) =>
    allowed.includes(value) ? undefined : 'not one of its values';
const matches =
  (pattern: RegExp, what: string): Check =>
  (value) =>
    typeof value === 'string' && pattern.test(value) ? undefined : `not ${what}`;
const count: Check = (value) =>
  isSafeCount(value) ? undefined : 'not a non-negative safe integer';
const boolean: Check = (value) => (typeof value === 'boolean' ? undefined : 'not a boolean');
const bounded =
  (max: number): Check =>
  (value) => {
    if (typeof value !== 'string') return 'not a string';
    if (value.length > max + ELLIPSIS.length) return `longer than ${max} characters`;
    if (value.endsWith(ELLIPSIS) && splitsHex(value)) return 'cut inside a hex value';
    return undefined;
  };
const address: Check = (value, { address: mode }) => {
  if (mode === 'off') return 'recorded in off mode';
  if (mode === 'hashed')
    return matches(/^sha256:[0-9a-f]{32}$/, 'a hashed address')(value, {} as never);
  return matches(/^0x[0-9a-f]{40}$/, 'a lower-case address')(value, {} as never);
};
const list =
  (max: number, item: Check): Check =>
  (value, modes) => {
    if (!Array.isArray(value)) return 'not an array';
    if (value.length > max) return `more than ${max} items`;
    for (const entry of value) {
      const problem = item(entry, modes);
      if (problem) return `an item is ${problem}`;
    }
    return undefined;
  };

/** What each attribute may hold (docs/semconv.md), whatever the input was. */
const ATTRIBUTE_CHECKS: Record<string, Check> = {
  'blockchain.system.name': oneOf('evm'),
  'blockchain.chain.id': (value) => (isChainId(value) ? undefined : 'not a positive safe integer'),
  'blockchain.operation.name': oneOf('send', 'confirm', 'payment'),
  'blockchain.tx.hash': matches(TX_HASH, 'a 32-byte hash'),
  'blockchain.tx.replacement.hash': matches(TX_HASH, 'a 32-byte hash'),
  'blockchain.tx.replacement.reason': oneOf('repriced', 'cancelled', 'replaced'),
  'blockchain.tx.status': oneOf('success', 'reverted', 'replaced'),
  'blockchain.tx.from': address,
  'blockchain.tx.to': address,
  'blockchain.tx.value': matches(DECIMAL, 'a decimal amount'),
  'blockchain.tx.nonce': count,
  'blockchain.tx.gas.used': count,
  'blockchain.tx.effective_gas_price': matches(DECIMAL, 'a decimal amount'),
  'blockchain.tx.l1_fee': matches(DECIMAL, 'a decimal amount'),
  'blockchain.tx.operator_fee': matches(DECIMAL, 'a decimal amount'),
  'blockchain.tx.fee': matches(DECIMAL, 'a decimal amount'),
  'blockchain.tx.revert.reason': bounded(BOUNDS.revertReason),
  'blockchain.tx.authorization.count': count,
  'blockchain.tx.authorization.addresses': list(BOUNDS.authorizations, address),
  'blockchain.tx.authorization.chain_ids': list(BOUNDS.authorizations, count),
  'blockchain.block.number': count,
  'blockchain.contract.function.name': matches(SOLIDITY_NAME, 'a function name'),
  'blockchain.contract.function.selector': matches(SELECTOR, 'a 4-byte selector'),
  'blockchain.contract.function.arguments': bounded(BOUNDS.functionArguments),
  'blockchain.payment.protocol': matches(IDENTIFIER, 'a short identifier'),
  'blockchain.payment.status': oneOf('settled', 'pending', 'failed'),
  'blockchain.payment.payer': address,
  'blockchain.payment.recipient': address,
  'blockchain.payment.asset': address,
  'blockchain.payment.amount': matches(DECIMAL, 'a decimal amount'),
  'blockchain.payment.settled_amount': matches(DECIMAL, 'a decimal amount'),
  'blockchain.payment.verified': boolean,
  'x402.scheme': matches(IDENTIFIER, 'a short identifier'),
  'x402.resource': bounded(BOUNDS.x402Resource),
  'blockchain.user_operation.hash': matches(TX_HASH, 'a 32-byte hash'),
  'blockchain.user_operation.sender': address,
  'blockchain.user_operation.entry_point': address,
  'blockchain.user_operation.paymaster': address,
  'blockchain.user_operation.call_count': count,
  'blockchain.user_operation.success': boolean,
  'blockchain.user_operation.gas.used': count,
  'blockchain.user_operation.gas.cost': matches(DECIMAL, 'a decimal amount'),
  'blockchain.user_operation.nonce': matches(DECIMAL, 'a decimal amount'),
  'blockchain.call_batch.id': matches(CALL_BATCH_ID, 'a call batch id of at most 256 characters'),
  'blockchain.call_batch.sender': address,
  'blockchain.call_batch.call_count': count,
  'blockchain.call_batch.status': oneOf('success', 'reverted', 'partially_reverted'),
  'blockchain.fee.payer': oneOf('facilitator', 'paymaster'),
  'blockchain.call_batch.status_code': count,
  'blockchain.call_batch.atomic': boolean,
  'blockchain.call_batch.transaction_hashes': list(
    BOUNDS.callBatchTransactionHashes,
    matches(TX_HASH, 'a 32-byte hash'),
  ),
  'exception.message': (value, { errorMessages }) => {
    if (errorMessages === 'off') return 'recorded in off mode';
    if (errorMessages === 'sanitized') {
      const problem = bounded(BOUNDS.sanitizedMessage)(value, {} as never);
      if (problem) return problem;
      if (typeof value === 'string' && value.includes('\n')) return 'more than one line';
      if (typeof value === 'string' && value.includes(SECRET)) return 'carrying a URL credential';
    }
    return undefined;
  },
  'exception.stacktrace': (_value, { errorMessages }) =>
    errorMessages === 'raw' ? undefined : `recorded in ${errorMessages} mode`,
};

/** Attributes whose value the user sets: the agent identity. */
const USER_SET = new Set(['gen_ai.agent.id', 'gen_ai.agent.name']);

/** Problems with one attribute set, each as `key: problem`. */
export function attributeProblems(
  attributes: Attributes,
  modes: RecordingModes = {},
  where = '',
): string[] {
  const resolved: Required<RecordingModes> = {
    address: modes.address ?? 'raw',
    errorMessages: modes.errorMessages ?? 'off',
  };
  const problems: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (USER_SET.has(key)) continue;
    const check = ATTRIBUTE_CHECKS[key];
    let problem = check?.(value, resolved);
    // Rule 4 for every attribute, including those without a check of their own (error.type, exception.type, rpc.*).
    if (
      problem === undefined &&
      !(key === 'exception.message' && resolved.errorMessages === 'raw')
    ) {
      if (
        key !== 'exception.stacktrace' &&
        typeof value === 'string' &&
        value.length > GENERIC_MAX_LENGTH
      ) {
        problem = `longer than ${GENERIC_MAX_LENGTH} characters`;
      }
      if (Array.isArray(value) && value.length > GENERIC_MAX_ITEMS) {
        problem = `more than ${GENERIC_MAX_ITEMS} items`;
      }
    }
    // Rule 6: an address never appears as itself where the address mode hides it; raw error messages, an opt-in,
    // are recorded as thrown.
    const rawError =
      resolved.errorMessages === 'raw' &&
      (key === 'exception.message' || key === 'exception.stacktrace');
    if (
      problem === undefined &&
      !rawError &&
      resolved.address !== 'raw' &&
      JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
        ?.toLowerCase()
        .includes(ADDRESS_HEX)
    ) {
      problem = `carrying an address in ${resolved.address} mode`;
    }
    if (problem !== undefined) problems.push(`${where}${key}: ${problem}`);
  }
  return problems;
}

/** The operation of a span (`send`, `confirm`, `payment` or a JSON-RPC method), without its chain id. */
const kindOf = (span: ReadableSpan): string => span.name.split(' ', 1)[0]?.slice(0, 40) ?? '';

/** Problems with every attribute of `spans` and their events (rules 3, 4 and 6). */
export function spanProblems(spans: readonly ReadableSpan[], modes: RecordingModes = {}): string[] {
  return spans.flatMap((span) => [
    ...attributeProblems(span.attributes, modes, `${kindOf(span)} `),
    ...span.events.flatMap((event) =>
      attributeProblems(event.attributes ?? {}, modes, `${kindOf(span)} ${event.name} event `),
    ),
    ...(span.name.length > GENERIC_MAX_LENGTH
      ? [`${span.name.slice(0, 40)}...: name too long`]
      : []),
  ]);
}

const METRIC_KEYS = new Set([
  'blockchain.system.name',
  'blockchain.chain.id',
  'blockchain.operation.subject',
  'blockchain.fee.payer',
  'blockchain.tx.status',
  'blockchain.user_operation.success',
  'blockchain.call_batch.status',
  'error.type',
]);
const ERROR_CLASS = /^[A-Z][A-Za-z]{0,62}Error$|^Error$/;
const ERROR_CODE = /^[a-z]{1,32}(_[a-z]{1,32}){0,7}$/;

/** Problems with metric samples (rule 5): attributes outside their closed sets. */
export function metricProblems(samples: readonly MetricSample[]): string[] {
  const problems: string[] = [];
  for (const { name, attributes } of samples) {
    for (const [key, value] of Object.entries(attributes)) {
      const problem = !METRIC_KEYS.has(key)
        ? 'not a metric attribute'
        : key === 'blockchain.chain.id'
          ? isChainId(value)
            ? undefined
            : 'not a positive safe integer'
          : key === 'error.type'
            ? typeof value === 'string' &&
              (value === '_OTHER' || ERROR_CLASS.test(value) || ERROR_CODE.test(value))
              ? undefined
              : 'not a class name, a code or _OTHER'
            : ATTRIBUTE_CHECKS[key]?.(value, { address: 'raw', errorMessages: 'off' });
      if (problem !== undefined)
        problems.push(`${name} ${key}=${String(value).slice(0, 40)}: ${problem}`);
    }
  }
  // And nothing outside the semantic conventions: metric names, label keys and closed label values.
  return [...problems, ...metricViolations(samples)];
}

/** The outcome of a call: what it returned or threw, comparable between an untraced and a traced run. */
export type Outcome =
  | { threw: false; value: unknown }
  | { threw: true; name: string; message: string };

/** How long the adapter runner waits for one call or flush to settle. */
export const SETTLE_LIMIT_MS = 10_000;

/**
 * Runs `call`, returning its outcome instead of throwing; awaits a returned promise, for at most `limitMs` when
 * given: a promise that never settles is an outcome of its own, so a run reports it instead of waiting forever.
 */
export async function outcomeOf(call: () => unknown, limitMs?: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = call();
    if (limitMs === undefined) return { threw: false, value: await result };
    const unsettled = new Promise<Outcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            threw: true,
            name: 'unsettled',
            message: `did not settle within ${limitMs} ms`,
          }),
        limitMs,
      );
    });
    return await Promise.race([
      Promise.resolve(result).then((value): Outcome => ({ threw: false, value })),
      unsettled,
    ]);
  } catch (error) {
    let name: string = typeof error;
    let message = '';
    try {
      if (error instanceof Error) {
        name = String(error.name);
        message = String(error.message);
      } else {
        message = String(error);
      }
    } catch {
      name = 'unreadable';
    }
    return { threw: true, name, message };
  } finally {
    clearTimeout(timer);
  }
}

// --- Adapters: the same call untraced and traced -------------------------------------------------------------------

/** What a call did, comparable between an untraced and a traced run. */
export function signature(outcome: Outcome): string {
  if (outcome.threw) return `threw ${outcome.name}: ${outcome.message.slice(0, 300)}`;
  try {
    const text = JSON.stringify(outcome.value, (_key, value: unknown) =>
      typeof value === 'bigint'
        ? `${value}n`
        : typeof value === 'symbol' || typeof value === 'function'
          ? typeof value
          : value,
    );
    return `returned ${typeof outcome.value} ${text?.slice(0, 300)}`;
  } catch {
    return `returned ${typeof outcome.value}`;
  }
}

/** The rules an adapter row is checked against; `same` is rule 1, `getters` rule 2. */
export type AdapterRule = 'same' | 'getters' | 'records' | 'metrics';

export interface AdapterScenario {
  /** Makes the call; may return a promise. */
  call(): unknown;
  /** Waits for the adapter's background work; must resolve true. Default: the setup's flush. */
  flush?(): Promise<unknown>;
  /** Requests the remote party got; those in the setup's `sending` must be the same untraced and traced. */
  requests?(): { method: string; params?: unknown }[];
  /** Reads of the caller's getters, for a scenario built with `getters`. */
  reads?(): number;
}

export interface AdapterRow<I> {
  /** The entry point and the input the hostile value goes into. */
  name: string;
  /** The values to try; default: the setup's. */
  values?(): [string, unknown][];
  /**
   * The scenario for `value`, instrumented with `traced` (none: untraced). With `getters`, the caller's arguments
   * are getters that count their reads.
   */
  scenario(
    value: unknown,
    traced: I | undefined,
    getters: boolean,
  ): AdapterScenario | Promise<AdapterScenario>;
  /** Whether `value` goes into the caller's arguments, so that rule 2 applies. */
  args?: boolean;
  /** Whether there is an untraced call to compare with; without one, the traced call must not throw. */
  untraced?: boolean;
  /** Options of the adapter besides the meter provider and the recording modes. */
  options?(value: unknown): object;
  /** Rules that apply; default: all that can. */
  rules?: readonly AdapterRule[];
  /** Rules that do not hold yet, with the finding's tag. */
  findings?: Partial<Record<AdapterRule, string>>;
}

export interface AdapterSetup<I> {
  /** Instruments with the adapter's options; called once per traced run. */
  instrument(options: object): I;
  /** Waits for the adapter's background work, for scenarios without their own flush. */
  flush(traced: I): Promise<unknown>;
  values(): [string, unknown][];
  modes: readonly RecordingModes[];
  tracing(): HostileTracing;
  meters: ReturnType<typeof recordingMeterProvider>;
  /** Request methods that carry what the call sends. */
  sending?: ReadonlySet<string>;
}

const ADAPTER_RULE_NAMES: Record<AdapterRule, string> = {
  same: 'has the outcome of the untraced call, never throws, and ends every span (rule 1)',
  getters: 'runs no more getters of the caller than the untraced call (rule 2)',
  records: 'records only valid, bounded values, and hidden data stays hidden (rules 3, 4, 6)',
  metrics: 'keeps metric attributes in closed sets (rule 5)',
};

async function runAdapterRow<I>(
  row: AdapterRow<I>,
  setup: AdapterSetup<I>,
): Promise<Record<AdapterRule, string[]>> {
  const problems: Record<AdapterRule, string[]> = {
    same: [],
    getters: [],
    records: [],
    metrics: [],
  };
  const valuesOf = row.values ?? setup.values;
  const labels = valuesOf().map(([label]) => label);
  // A request can carry the hostile value itself (a Proxy that throws when read): it is then compared by method only.
  const sentBy = (scenario: AdapterScenario): string =>
    (scenario.requests?.() ?? [])
      .filter((request) => setup.sending?.has(request.method))
      .map((request) => {
        try {
          return JSON.stringify(request, (_key, value: unknown) =>
            typeof value === 'bigint' ? `${value}n` : value,
          );
        } catch {
          return `${request.method} with unreadable params`;
        }
      })
      .join('\n');
  const settle = async (scenario: AdapterScenario, traced: I): Promise<Outcome> =>
    outcomeOf(() => (scenario.flush ? scenario.flush() : setup.flush(traced)), SETTLE_LIMIT_MS);
  const tracing = setup.tracing();
  for (const modes of setup.modes) {
    for (const [index, name] of labels.entries()) {
      const fresh = (): unknown => (valuesOf()[index] as [string, unknown])[1];
      const label = `${name} (${modes.address ?? 'raw'} addresses)`;
      tracing.reset();
      setup.meters.reset();
      const began = Date.now();
      let untraced: { outcome: string; sent: string } | undefined;
      if (row.untraced !== false) {
        const plain = await row.scenario(fresh(), undefined, false);
        untraced = {
          outcome: signature(await outcomeOf(() => plain.call(), SETTLE_LIMIT_MS)),
          sent: sentBy(plain),
        };
      }
      const traced = setup.instrument({
        meterProvider: setup.meters.provider,
        ...modes,
        ...(row.options?.(fresh()) ?? {}),
      });
      const scenario = await row.scenario(fresh(), traced, false);
      const outcome = signature(await outcomeOf(() => scenario.call(), SETTLE_LIMIT_MS));
      const flushed = await settle(scenario, traced);
      if (untraced) {
        if (outcome !== untraced.outcome)
          problems.same.push(`${label}: traced ${outcome}, untraced ${untraced.outcome}`);
        if (sentBy(scenario) !== untraced.sent) problems.same.push(`${label}: sent something else`);
      } else if (outcome.startsWith('threw')) {
        problems.same.push(`${label}: ${outcome}`);
      }
      if (flushed.threw || flushed.value !== true)
        problems.same.push(`${label}: flush gave ${signature(flushed)}`);
      if (tracing.open() > 0) problems.same.push(`${label}: left ${tracing.open()} span(s) open`);
      for (const problem of spanProblems(tracing.spans(), modes))
        problems.records.push(`${label}: ${problem}`);
      for (const problem of metricProblems(setup.meters.samples()))
        problems.metrics.push(`${label}: ${problem}`);

      debugSlow(`${row.name} | ${label}`, Date.now() - began);
      if (row.args && modes === setup.modes[0]) {
        const plain = await row.scenario(fresh(), undefined, true);
        await outcomeOf(() => plain.call(), SETTLE_LIMIT_MS);
        const tracedGetters = setup.instrument({ meterProvider: setup.meters.provider });
        const counted = await row.scenario(fresh(), tracedGetters, true);
        await outcomeOf(() => counted.call(), SETTLE_LIMIT_MS);
        await settle(counted, tracedGetters);
        if (counted.reads?.() !== plain.reads?.()) {
          problems.getters.push(
            `${label}: ${counted.reads?.()} getter reads traced, ${plain.reads?.()} untraced`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Registers a `describe` per row with one test per rule; a rule with a finding is `it.fails`. Set `HOSTILE_DEBUG` to
 * a file path to have every problem of a failing rule appended to it as JSON.
 */
export function describeAdapterRows<I>(
  rows: readonly AdapterRow<I>[],
  setup: AdapterSetup<I>,
): void {
  for (const row of rows) {
    describe(row.name, () => {
      let results: Record<AdapterRule, string[]> | undefined;
      beforeAll(async () => {
        const began = Date.now();
        results = await runAdapterRow(row, setup);
        debugSlow(`${row.name} | the whole row`, Date.now() - began);
      }, 600_000);
      const rules =
        row.rules ??
        (['same', ...(row.args ? ['getters'] : []), 'records', 'metrics'] as AdapterRule[]);
      for (const rule of rules) {
        const finding = row.findings?.[rule];
        // finding: see the tag, listed with a repro in the pull request that added it.
        (finding ? it.fails : it)(
          `${ADAPTER_RULE_NAMES[rule]}${finding ? ` [finding: ${finding}]` : ''}`,
          () => {
            const problems = results?.[rule] ?? ['not run'];
            debugProblems(`${row.name} | ${rule}`, problems);
            expect(problems).toEqual([]);
          },
        );
      }
    });
  }
}

/** Notes a run slower than half a second next to the file named by `HOSTILE_DEBUG`, if set. */
function debugSlow(run: string, ms: number): void {
  const file = process.env.HOSTILE_DEBUG;
  if (file && ms > 500) appendFileSync(`${file}.slow`, `${run}: ${ms} ms\n`);
}

/** Appends `problems` to the file named by `HOSTILE_DEBUG`, if set, for reading them in full. */
export function debugProblems(test: string, problems: readonly string[]): void {
  const file = process.env.HOSTILE_DEBUG;
  if (file && problems.length > 0) appendFileSync(file, `${JSON.stringify({ test, problems })}\n`);
}
