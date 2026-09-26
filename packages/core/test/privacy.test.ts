import { describe, expect, it } from 'vitest';
import { resolveAddressFormatter } from '../src/privacy.js';

const ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

describe('resolveAddressFormatter', () => {
  it('defaults to raw and preserves the address as given', () => {
    expect(resolveAddressFormatter(undefined)(ADDRESS)).toBe(ADDRESS);
    expect(resolveAddressFormatter('raw')(ADDRESS)).toBe(ADDRESS);
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
