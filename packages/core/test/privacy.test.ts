import { diag } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAddressFormatter } from '../src/privacy.js';

const ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

describe('resolveAddressFormatter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to off when SHA-256 is unavailable', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    expect(resolveAddressFormatter('hashed')(ADDRESS)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to off for an unknown mode', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    expect(resolveAddressFormatter('bogus' as never)(ADDRESS)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('defaults to raw and records the address in lower case', () => {
    expect(resolveAddressFormatter(undefined)(ADDRESS)).toBe(ADDRESS.toLowerCase());
    expect(resolveAddressFormatter('raw')(ADDRESS)).toBe(ADDRESS.toLowerCase());
  });

  it('drops addresses in off mode', () => {
    expect(resolveAddressFormatter('off')(ADDRESS)).toBeUndefined();
  });

  it('hashes case-insensitively with a stable, prefixed sha256 digest', () => {
    const format = resolveAddressFormatter('hashed');
    const hashed = format(ADDRESS);
    expect(hashed).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(format(ADDRESS.toLowerCase())).toBe(hashed);
    expect(format('0x0000000000000000000000000000000000000001')).not.toBe(hashed);
  });

  it('uses a custom hash function when provided', () => {
    const format = resolveAddressFormatter({ mode: 'hashed', hash: (a) => `h(${a})` });
    expect(format(ADDRESS)).toBe(`h(${ADDRESS.toLowerCase()})`);
  });
});
