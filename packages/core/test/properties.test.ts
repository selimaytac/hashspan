// Property-based tests of the cutting, address and redaction code (issue #292), on top of the hostile-input table
// (ADR 0025): generated inputs instead of listed ones. Properties: never throws, stays within its bound, leaves no part
// of an address after a cut, and gives the same output for the same input. The seed is fixed, so CI runs the same
// cases; fast-check prints the seed and the shrunk input of a failure. Set FC_SEED to explore other cases locally.
import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTxTracker } from '../src/index.js';
import {
  boundRevertReason,
  cutAt,
  formatAddressesIn,
  paymentResourceOf,
  resolveAddressFormatter,
  sanitizeErrorMessage,
  serializeFunctionArguments,
} from '../src/privacy.js';
import { setupTracing, type TestTracing } from './helpers.js';

beforeAll(() => {
  fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 20_261_004), numRuns: 200 });
});

const OFF = resolveAddressFormatter('off');
const HASHED = resolveAddressFormatter({ mode: 'hashed', hash: (a) => `h${a.length}` });
const RAW = resolveAddressFormatter('raw');

const hexDigits = (min: number, max: number) =>
  fc.string({ unit: fc.constantFrom(...'0123456789abcdefABCDEF'), minLength: min, maxLength: max });
const address = hexDigits(40, 40).map((hex) => `0x${hex}`);
/** Text with addresses and other hex values in it, as error messages, reasons and paths carry them. */
const textWithAddresses = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 40 }),
      address,
      hexDigits(1, 80).map((hex) => `0x${hex}`),
      fc.constantFrom(' ', '/', '(', ')', ', ', '\n', '...'),
    ),
    { maxLength: 60 },
  )
  .map((parts) => parts.join(''));

/** The 40-digit runs of `text` that are addresses, lower case. */
const addressesIn = (text: string): string[] =>
  [...text.matchAll(/0[xX]([0-9a-fA-F]{40})(?![0-9a-fA-F])/g)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
/** Whether `output` still holds 20 or more consecutive digits of one of `addresses`. */
const leaksPartOf = (output: string, addresses: string[]): boolean => {
  const lower = output.toLowerCase();
  return addresses.some((digits) => {
    for (let i = 0; i + 20 <= digits.length; i++)
      if (lower.includes(digits.slice(i, i + 20))) return true;
    return false;
  });
};

describe('cutAt', () => {
  it('keeps text within its bound, and drops a hex value the cut would split', () => {
    fc.assert(
      fc.property(textWithAddresses, fc.integer({ min: 0, max: 200 }), (text, max) => {
        const cut = cutAt(text, max);
        expect(cut).toBe(cutAt(text, max));
        if (text.length <= max) {
          expect(cut).toBe(text);
          return;
        }
        expect(cut.length).toBeLessThanOrEqual(max + 3);
        expect(cut.endsWith('...')).toBe(true);
        const head = cut.slice(0, -3);
        expect(text.startsWith(head)).toBe(true);
        // A `0x` right after the cut starts a new value, so the value before it was not split.
        const rest = text.slice(head.length);
        const splitsHex =
          /0[xX][0-9a-fA-F]*$/.test(head) && /^[0-9a-fA-F]/.test(rest) && !/^0[xX]/.test(rest);
        expect(splitsHex).toBe(false);
      }),
    );
  });
});

describe('formatAddressesIn', () => {
  it.each([
    ['off', OFF],
    ['hashed', HASHED],
  ] as const)('leaves no part of an address in %s mode', (_, formatter) => {
    fc.assert(
      fc.property(textWithAddresses, (text) => {
        const formatted = formatAddressesIn(text, formatter);
        expect(formatted).toBe(formatAddressesIn(text, formatter));
        expect(leaksPartOf(formatted, addressesIn(text))).toBe(false);
      }),
    );
  });
});

describe('boundRevertReason', () => {
  it('stays within 1024 characters and the ellipsis, and leaves no part of an address in off mode', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          textWithAddresses,
          textWithAddresses.map((t) => t.repeat(30)),
        ),
        (reason) => {
          const bounded = boundRevertReason(reason, OFF);
          expect(bounded.length).toBeLessThanOrEqual(1024 + 3);
          expect(leaksPartOf(bounded, addressesIn(reason))).toBe(false);
        },
      ),
    );
  });
});

describe('sanitizeErrorMessage', () => {
  const secret = hexDigits(24, 24).map((hex) => `s${hex}`);
  it('keeps the first line within its bound, without addresses or the path and query of a URL', () => {
    fc.assert(
      fc.property(
        textWithAddresses,
        secret,
        fc.constantFrom('https', 'http', 'wss'),
        fc.constantFrom(' ', '', '_', 'rpc_', '1', 'x'.repeat(40)),
        (text, token, scheme, before) => {
          const message = `${text}${before}${scheme}://user:pw@rpc.example.com/v2/${token}?apikey=${token} ${text}`;
          const sanitized = sanitizeErrorMessage(message, OFF);
          expect(sanitized).toBe(sanitizeErrorMessage(message, OFF));
          expect(sanitized.length).toBeLessThanOrEqual(256 + 3);
          expect(sanitized.includes('\n')).toBe(false);
          expect(sanitized.toLowerCase().includes(token)).toBe(false);
          expect(sanitized.includes('user:pw')).toBe(false);
          expect(leaksPartOf(sanitized, addressesIn(message))).toBe(false);
        },
      ),
    );
  });
});

describe('sanitizeErrorMessage around its scan bound', () => {
  it('leaves no part of an address that follows a long hex run near the bound', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4000, max: 4200 }),
        address,
        fc.constantFrom('', ' tail', 'f'),
        (run, value, tail) => {
          const message = `failed 0x${'f'.repeat(run)}${value}${tail}`;
          for (const mode of [OFF, HASHED]) {
            expect(leaksPartOf(sanitizeErrorMessage(message, mode), addressesIn(message))).toBe(
              false,
            );
          }
        },
      ),
    );
  });
});

describe('paymentResourceOf', () => {
  it('records no query, fragment or user info, within 512 characters and the ellipsis', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.string(),
        (url, extra) => {
          for (const mode of ['origin', 'path'] as const) {
            const recorded = paymentResourceOf(`${url}${extra}`, mode);
            if (recorded === undefined) continue;
            expect(recorded.length).toBeLessThanOrEqual(512 + 3);
            expect(/[?#]/.test(recorded)).toBe(false);
          }
        },
      ),
    );
  });
});

describe('serializeFunctionArguments', () => {
  it('stays within 4096 characters and the ellipsis, and is deterministic', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue({ maxDepth: 8 }), { maxLength: 20 }), (args) => {
        const serialized = serializeFunctionArguments(args, RAW);
        expect(serialized).toBe(serializeFunctionArguments(args, RAW));
        expect(serialized.length).toBeLessThanOrEqual(4096 + 3);
      }),
    );
  });
});

describe('the EIP-7702 authorization list', () => {
  let tracing: TestTracing;
  beforeEach(() => {
    tracing = setupTracing();
  });
  afterEach(async () => {
    await tracing.teardown();
  });

  it('records at most 64 well-formed entries, and counts them all', () => {
    const entry = fc.oneof(fc.record({ address, chainId: fc.nat() }), fc.anything());
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 200 }), (authorizations) => {
        tracing.exporter.reset();
        createTxTracker()
          .startSend({ chainId: 8453, authorizations: authorizations as never })
          .end({ hash: `0x${'ab'.repeat(32)}` });
        const attributes = tracing.spans()[0]?.attributes ?? {};
        if (authorizations.length === 0) {
          expect(attributes['blockchain.tx.authorization.count']).toBeUndefined();
          return;
        }
        expect(attributes['blockchain.tx.authorization.count']).toBe(authorizations.length);
        const addresses = (attributes['blockchain.tx.authorization.addresses'] ?? []) as string[];
        const chainIds = (attributes['blockchain.tx.authorization.chain_ids'] ?? []) as number[];
        expect(addresses.length).toBeLessThanOrEqual(64);
        expect(chainIds.length).toBe(addresses.length);
      }),
    );
  });
});
