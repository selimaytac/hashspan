// Property-based tests of revert data decoding (issue #292), on top of the hostile-input table (ADR 0025): the data
// comes from the node, and for a custom error from the contract. Properties: never throws, stays within its bound,
// decodes what it can exactly, and gives the same output for the same input. The seed is fixed, so CI runs the same
// cases; fast-check prints the seed and the shrunk input of a failure. Set FC_SEED to explore other cases locally.
import fc from 'fast-check';
import { encodeErrorResult, type Hex, parseAbi } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatRevertData } from '../src/revert-reason.js';

beforeAll(() => {
  fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 20_261_004), numRuns: 200 });
});

const MAX = 1024 + 3;
const errorString = parseAbi(['error Error(string)']);
const panic = parseAbi(['error Panic(uint256)']);
const custom = parseAbi(['error Denied(address account, uint256 amount, bytes data)']);
const hexBytes = (max: number) =>
  fc
    .uint8Array({ maxLength: max })
    .map((bytes) => `0x${Buffer.from(bytes).toString('hex')}` as Hex);

describe('formatRevertData', () => {
  it('never throws on any data, and stays within its bound', () => {
    fc.assert(
      fc.property(hexBytes(2_000), fc.boolean(), (data, withAbi) => {
        const reason = formatRevertData(data, withAbi ? custom : undefined);
        expect(reason).toBe(formatRevertData(data, withAbi ? custom : undefined));
        if (reason !== undefined) expect(reason.length).toBeLessThanOrEqual(MAX);
      }),
    );
  });

  it('returns an Error(string) message as it is, cut to its bound', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3_000 }), (message) => {
        const data = encodeErrorResult({ abi: errorString, errorName: 'Error', args: [message] });
        const reason = formatRevertData(data, undefined) as string;
        if (message.length <= 1024) expect(reason).toBe(message);
        else expect(message.startsWith(reason.slice(0, -3))).toBe(true);
        expect(reason.length).toBeLessThanOrEqual(MAX);
      }),
    );
  });

  it('formats a Panic code in hex', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), (code) => {
        const data = encodeErrorResult({ abi: panic, errorName: 'Panic', args: [code] });
        expect(formatRevertData(data, undefined)).toBe(`Panic(0x${code.toString(16)})`);
      }),
    );
  });

  it('decodes a custom error of a known ABI, whatever its arguments', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }),
        hexBytes(1_500),
        (account, amount, extra) => {
          const address = `0x${Buffer.from(account).toString('hex')}` as Hex;
          const data = encodeErrorResult({
            abi: custom,
            errorName: 'Denied',
            args: [address, amount, extra],
          });
          const reason = formatRevertData(data, custom) as string;
          expect(reason.startsWith('Denied(')).toBe(true);
          expect(reason.length).toBeLessThanOrEqual(MAX);
          // Without the ABI only the selector is known.
          expect(formatRevertData(data, undefined)).toBe(data.slice(0, 10));
        },
      ),
    );
  });
});
