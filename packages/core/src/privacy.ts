import { diag } from '@opentelemetry/api';
import type {
  AddressMode,
  AddressOptions,
  ErrorMessageMode,
  PaymentResourceMode,
} from './types.js';

/** Formats one address per the address mode; undefined means "do not record it". */
export interface AddressFormatter {
  (address: string): string | undefined;
  /**
   * True when addresses must not be recorded as they are (`off`, `hashed`). Hex values longer than an address can
   * embed one (a padded bytes32, ABI-encoded bytes), so they are then replaced by `<hex>` too.
   */
  readonly protectsAddresses: boolean;
}

const formatter = (
  format: (address: string) => string | undefined,
  protectsAddresses: boolean,
): AddressFormatter => Object.assign(format, { protectsAddresses });

/** Records no addresses; the fallback whenever the address mode cannot be applied. */
export const OFF_ADDRESS_FORMATTER: AddressFormatter = formatter(() => undefined, true);

type HashFn = (address: string) => string;

interface NodeCrypto {
  createHash(algorithm: string): { update(data: string): { digest(encoding: 'hex'): string } };
}

/** Loads node:crypto lazily so the package stays importable in non-Node runtimes. */
function defaultHash(): HashFn | undefined {
  const getBuiltinModule = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
  ).process?.getBuiltinModule;
  const crypto = getBuiltinModule?.('node:crypto') as NodeCrypto | undefined;
  if (!crypto) return undefined;
  return (address) =>
    `sha256:${crypto.createHash('sha256').update(address).digest('hex').slice(0, 32)}`;
}

export function resolveAddressFormatter(
  option: AddressMode | AddressOptions | undefined,
): AddressFormatter {
  const { mode, hash } =
    typeof option === 'object' ? option : { mode: option ?? 'raw', hash: undefined };
  switch (mode) {
    case 'raw':
      // One form for every source: send arguments are often EIP-55 checksummed, receipts often lower case.
      return formatter((address) => address.toLowerCase(), false);
    case 'off':
      return OFF_ADDRESS_FORMATTER;
    case 'hashed': {
      const hashFn = hash ?? defaultHash();
      if (!hashFn) {
        diag.warn('hashspan: no SHA-256 available in this runtime; addresses will not be recorded');
        return OFF_ADDRESS_FORMATTER;
      }
      return formatter((address) => hashFn(address.toLowerCase()), true);
    }
    default:
      diag.warn(`hashspan: unknown address mode "${String(mode)}"; addresses will not be recorded`);
      return OFF_ADDRESS_FORMATTER;
  }
}

/** 0x-prefixed hex. Unprefixed hex and addresses written as numbers are not detected. */
const HEX = /0[xX][0-9a-fA-F]+/g;
const ADDRESS_LENGTH = 42;
/**
 * Longest hex kept in sanitized error messages in raw address mode: a 32-byte word such as a transaction hash. In
 * `off` and `hashed` mode, {@link formatAddressesIn} already replaces any hex longer than an address.
 */
const MAX_HEX_LENGTH = 66;
const MAX_MESSAGE_LENGTH = 256;
/** A URL in free text: `scheme://` up to the next whitespace, quote or bracket; the bounded scheme keeps it linear. */
const URL_IN_TEXT = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s"'<>()[\]{}]+/g;

/**
 * Rewrites every address in `text` with the address mode (`<address>` when it records none). In `off` and `hashed`
 * mode, hex values longer than an address become `<hex>`, because they can embed one.
 */
export function formatAddressesIn(text: string, formatAddress: AddressFormatter): string {
  return text.replace(HEX, (hex) => {
    if (hex.length === ADDRESS_LENGTH) return formatAddress(hex) ?? '<address>';
    return hex.length > ADDRESS_LENGTH && formatAddress.protectsAddresses ? '<hex>' : hex;
  });
}

/**
 * First line of an error message with URLs cut to their origin (an RPC URL can carry an API key in its path or
 * query), addresses per address mode and longer hex data (such as calldata) replaced by `<hex>`. Best effort: other
 * free text is kept, so the redaction hook still runs on the result.
 */
export function sanitizeErrorMessage(message: string, formatAddress: AddressFormatter): string {
  const firstLine = (message.split('\n', 1)[0]?.trim() ?? '').replace(URL_IN_TEXT, (url) =>
    hidesUserInfo(url) ? '<url>' : (originOf(url) ?? '<url>'),
  );
  const sanitized = formatAddressesIn(firstLine, formatAddress).replace(HEX, (hex) =>
    hex.length > MAX_HEX_LENGTH ? '<hex>' : hex,
  );
  return sanitized.length > MAX_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_MESSAGE_LENGTH)}...`
    : sanitized;
}

const MAX_ARGUMENTS_LENGTH = 4096;
const MAX_ARGUMENTS_DEPTH = 32;

class ArgumentsLimitReached extends Error {}

/**
 * Call arguments as a JSON array: bigints as decimal strings, addresses per address mode (see
 * {@link formatAddressesIn}), at most `MAX_ARGUMENTS_LENGTH` characters followed by `...`.
 *
 * Side-effect free for ordinary values: it reads only own enumerable data properties and never calls `toJSON()` or
 * getters (so a `Date` records as `{}`). A Proxy's traps still run, as for any property read; use the redaction
 * hook, or leave arguments off, for values that are Proxies. It stops after the value that crosses the length limit instead of walking the rest. Functions, symbols and `undefined` are skipped in objects and written as `null` in arrays, as in
 * JSON. Throws for cycles and for nesting deeper than `MAX_ARGUMENTS_DEPTH`.
 */
export function serializeFunctionArguments(
  args: readonly unknown[],
  formatAddress: AddressFormatter,
): string {
  let out = '';
  const write = (chunk: string): void => {
    out += chunk;
    if (out.length > MAX_ARGUMENTS_LENGTH) throw new ArgumentsLimitReached();
  };
  const text = (value: string): string => JSON.stringify(formatAddressesIn(value, formatAddress));
  const ancestors = new Set<object>();

  /** Writes `value`; returns false, writing nothing, when it has no JSON representation. */
  const walk = (value: unknown, depth: number): boolean => {
    switch (typeof value) {
      case 'string':
        write(text(value));
        return true;
      case 'bigint':
        write(`"${value.toString()}"`);
        return true;
      case 'number':
        write(Number.isFinite(value) ? String(value) : 'null');
        return true;
      case 'boolean':
        write(value ? 'true' : 'false');
        return true;
      case 'object':
        break;
      default:
        return false; // undefined, function, symbol
    }
    if (value === null) {
      write('null');
      return true;
    }
    if (ancestors.has(value)) throw new TypeError('cyclic function arguments');
    if (depth >= MAX_ARGUMENTS_DEPTH) throw new TypeError('function arguments nested too deeply');
    ancestors.add(value);
    // Descriptors are read one at a time, so the walk stops reading at the length limit.
    const own = (key: string): PropertyDescriptor | undefined =>
      Object.getOwnPropertyDescriptor(value, key);
    if (Array.isArray(value)) {
      write('[');
      const length = own('length')?.value;
      for (let i = 0; i < (typeof length === 'number' ? length : 0); i++) {
        if (i > 0) write(',');
        const element = own(String(i));
        if (!element || !('value' in element) || !walk(element.value, depth + 1)) write('null');
      }
      write(']');
    } else {
      write('{');
      let first = true;
      for (const key of Object.keys(value)) {
        const descriptor = own(key);
        if (!descriptor || !('value' in descriptor)) continue; // skips accessors
        const kind = typeof descriptor.value;
        if (kind === 'undefined' || kind === 'function' || kind === 'symbol') continue;
        write(`${first ? '' : ','}${text(key)}:`);
        first = false;
        walk(descriptor.value, depth + 1);
      }
      write('}');
    }
    ancestors.delete(value);
    return true;
  };

  try {
    walk(args, 0);
    return out;
  } catch (error) {
    if (error instanceof ArgumentsLimitReached) return `${out.slice(0, MAX_ARGUMENTS_LENGTH)}...`;
    throw error;
  }
}

export function resolveErrorMessageMode(mode: ErrorMessageMode | undefined): ErrorMessageMode {
  if (mode === undefined || mode === 'off' || mode === 'sanitized' || mode === 'raw') {
    return mode ?? 'off';
  }
  diag.warn(`hashspan: unknown error message mode "${String(mode)}"; recording error types only`);
  return 'off';
}

export function resolvePaymentResourceMode(
  mode: PaymentResourceMode | undefined,
): PaymentResourceMode {
  if (mode === undefined || mode === 'origin' || mode === 'path' || mode === 'off') {
    return mode ?? 'origin';
  }
  diag.warn(
    `hashspan: unknown payment resource mode "${String(mode)}"; not recording payment resources`,
  );
  return 'off';
}

/** The origin of a URL: `scheme://`, then the host and port, without user info. */
const URL_ORIGIN = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^/?#]+)/;

/**
 * The part of a payment's resource that `mode` records, or undefined for none. Works on the text, so it never throws
 * for a resource that is not a URL.
 */
export function paymentResourceOf(resource: string, mode: PaymentResourceMode): string | undefined {
  if (mode === 'off' || hidesUserInfo(resource)) return undefined;
  const recorded = mode === 'path' ? sanitizeResource(resource) : originOf(resource);
  if (recorded === undefined) return undefined;
  return cutAt(recorded, MAX_RESOURCE_LENGTH);
}

/**
 * `text` cut to `max` characters, followed by `...`. A hex value that the cut splits is dropped whole: the part left
 * is shorter than an address, so the address mode, applied later, would no longer recognise it as one.
 */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${/^[0-9a-fA-F]/.test(text.slice(max)) ? head.replace(/0[xX][0-9a-fA-F]*$/, '') : head}...`;
}

/** Longest `x402.resource` recorded; the value comes from the server that asks for the payment. */
const MAX_RESOURCE_LENGTH = 512;

function originOf(resource: string): string | undefined {
  const origin = URL_ORIGIN.exec(resource);
  return origin ? `${origin[1]}${origin[2]}` : undefined;
}

/**
 * True for `scheme://` text whose user info contains `?` or `#`, such as `https://user:p?ss@host`. A valid URL
 * percent-encodes them; reading such text by its first `?` or `#` would record part of the user info as the host.
 */
function hidesUserInfo(resource: string): boolean {
  const scheme = URL_SCHEME.exec(resource);
  if (!scheme) return false;
  const rest = resource.slice(scheme[0].length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  return at !== -1 && /[?#]/.test(authority.slice(0, at));
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** `scheme://user:password@` at the start of a URL; the user info is removed. */
const URL_USER_INFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

/**
 * The resource of a payment without what can carry credentials: the query string, the fragment and the user info.
 * Works on the text, so names that are not URLs are kept as they are.
 */
export function sanitizeResource(resource: string): string {
  const end = resource.search(/[?#]/);
  const withoutQuery = end === -1 ? resource : resource.slice(0, end);
  return withoutQuery.replace(URL_USER_INFO, '$1');
}
