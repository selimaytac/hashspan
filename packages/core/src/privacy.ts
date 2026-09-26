import { diag } from '@opentelemetry/api';
import type { AddressMode, AddressOptions } from './types.js';

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
