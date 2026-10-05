import { diag } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAddressFormatter, sanitizeErrorMessage } from '../src/privacy.js';

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

describe('sanitizeErrorMessage on a long single line', () => {
  // The URL and hex passes scan the first 4096 characters of the line (and the rest of a hex value cut there); the
  // recorded message is cut to 256 characters, so what is recorded is the same as without that bound.
  const modes = {
    off: resolveAddressFormatter('off'),
    hashed: resolveAddressFormatter({ mode: 'hashed', hash: (a) => `h(${a})` }),
    raw: resolveAddressFormatter('raw'),
  };
  const MB = 1_000_000;

  describe.each(Object.entries(modes))('in %s address mode', (_, format) => {
    it('records the first 256 characters of a 1 MB line of letters', () => {
      const message = `execution failed: ${'lorem ipsum '.repeat(MB / 12)}`;
      expect(sanitizeErrorMessage(message, format)).toBe(`${message.slice(0, 256)}...`);
    });

    it('records a 1 MB hex value as <hex>', () => {
      expect(sanitizeErrorMessage(`call failed: data 0x${'ab'.repeat(MB / 2)}`, format)).toBe(
        'call failed: data <hex>',
      );
    });

    it('records a hex value that the bound splits as it records the whole value', () => {
      const address = format(ADDRESS) ?? '<address>';
      // The bound splits the address after its 41st and 16th character and between its `0` and `x`, or falls right
      // before it.
      for (const start of [4055, 4080, 4095, 4096]) {
        // A hex value before it that is recorded as <hex>, so the split value is within the recorded 256 characters.
        const before = `from ${ADDRESS} 0x${'e'.repeat(start - ADDRESS.length - 9)} `;
        expect(before).toHaveLength(start);
        expect(sanitizeErrorMessage(`${before}${ADDRESS} ${'z'.repeat(MB)}`, format)).toBe(
          `from ${address} <hex> ${address}`,
        );
        expect(sanitizeErrorMessage(`${before}0x${'cd'.repeat(MB / 2)}`, format)).toBe(
          `from ${address} <hex> <hex>`,
        );
      }
    });

    it('reduces a URL that the bound cuts in its path to its origin', () => {
      const message = `0x${'ab'.repeat(2000)} https://rpc.example.com/v2/${'k'.repeat(MB)}`;
      expect(sanitizeErrorMessage(message, format)).toBe('<hex> https://rpc.example.com');
    });

    it('records a URL that the bound cuts in its user info as <url>', () => {
      // The bound falls inside `secret`.
      const message = `0x${'ab'.repeat(2038)} https://user:secret@rpc.example.com/v2/key ${'z'.repeat(MB)}`;
      const sanitized = sanitizeErrorMessage(message, format);
      expect(sanitized).toBe('<hex> <url>');
      expect(sanitized).not.toContain('user');
    });
  });
});
