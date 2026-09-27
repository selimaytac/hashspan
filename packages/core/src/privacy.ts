import { diag } from '@opentelemetry/api';
import type { AddressMode, AddressOptions, ErrorMessageMode } from './types.js';

export type AddressFormatter = (address: string) => string | undefined;

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
      return (address) => address;
    case 'off':
      return () => undefined;
    case 'hashed': {
      const hashFn = hash ?? defaultHash();
      if (!hashFn) {
        diag.warn('hashspan: no SHA-256 available in this runtime; addresses will not be recorded');
        return () => undefined;
      }
      return (address) => hashFn(address.toLowerCase());
    }
    default:
      diag.warn(`hashspan: unknown address mode "${String(mode)}"; addresses will not be recorded`);
      return () => undefined;
  }
}

const HEX = /0x[0-9a-fA-F]+/g;
const ADDRESS_LENGTH = 42;
/** Longest hex kept in sanitized error messages: a 32-byte word such as a transaction hash. */
const MAX_HEX_LENGTH = 66;
const MAX_MESSAGE_LENGTH = 256;

/** Rewrites every address in `text` with the address mode; `off` replaces it with `<address>`. */
export function formatAddressesIn(text: string, formatAddress: AddressFormatter): string {
  return text.replace(HEX, (hex) =>
    hex.length === ADDRESS_LENGTH ? (formatAddress(hex) ?? '<address>') : hex,
  );
}

/**
 * First line of an error message with addresses per address mode and longer hex data (such as calldata)
 * replaced by `<hex>`. Best effort: other free text is kept, so the redaction hook still runs on the result.
 */
export function sanitizeErrorMessage(message: string, formatAddress: AddressFormatter): string {
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  const sanitized = formatAddressesIn(firstLine, formatAddress).replace(HEX, (hex) =>
    hex.length > MAX_HEX_LENGTH ? '<hex>' : hex,
  );
  return sanitized.length > MAX_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_MESSAGE_LENGTH)}...`
    : sanitized;
}

export function resolveErrorMessageMode(mode: ErrorMessageMode | undefined): ErrorMessageMode {
  if (mode === undefined || mode === 'off' || mode === 'sanitized' || mode === 'raw') {
    return mode ?? 'off';
  }
  diag.warn(`hashspan: unknown error message mode "${String(mode)}"; recording error types only`);
  return 'off';
}
