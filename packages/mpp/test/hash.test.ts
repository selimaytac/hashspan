// The payer's own hash, derived as mppx derives it (ADR 0029): compared, credential by credential, with the
// `transactionHash` of mppx's own `PaymentOutcomeUnknownError`, which mppx computes from the same credential when the
// paid request fails with a 5xx. The test's credentials replace the client's through an observer registered after
// hashspan's, as a user's `onChallengeReceived` may supply one.
import { fromRlp, type Hex, toRlp } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import {
  PAYMENT_SPAN,
  paidApi,
  paidServer,
  recodeCredential,
  testClient,
  URL_PAID,
} from './fake-mppx.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

type Rlp = Hex | Rlp[];

/** A signed Tempo transaction (`0x76` and its RLP list) with its list changed by `change`. */
function changeTransaction(serialized: Hex, change: (fields: Rlp[]) => Rlp[]): Hex {
  const fields = fromRlp(`0x${serialized.slice(4)}`, 'hex') as Rlp[];
  return `0x76${toRlp(change(fields) as never).slice(2)}` as Hex;
}

/** Changes the signed transaction of a pull credential. */
const withSignature =
  (change: (signature: Hex) => Hex) =>
  (credential: string): string =>
    recodeCredential(credential, (json) => {
      const payload = json.payload as { signature: Hex };
      payload.signature = change(payload.signature);
    });

interface Case {
  mode: 'push' | 'pull';
  sponsored?: boolean;
  change?: (credential: string) => string;
}

/** Pays with the credential `change` makes, answers 500, and returns mppx's hash and the one hashspan recorded. */
async function hashes({ mode, sponsored, change }: Case) {
  const api = paidApi(
    () => new Response('failed', { status: 500 }),
    paidServer({ feePayer: sponsored === true }),
  );
  const client = testClient(api.fetch, { mode });
  withHashspan(client, { observeFailures: true });
  if (change) {
    client.onChallengeReceived(async ({ createCredential }) => change(await createCredential()));
  }
  let fromMppx: unknown = 'not reported';
  client.onPaymentFailed(({ error }) => {
    fromMppx = (error as { transactionHash?: unknown }).transactionHash;
  });
  const response = await client.fetch(URL_PAID);
  expect(response.status).toBe(500);
  const span = tracing
    .spans()
    .filter(({ name }) => name === PAYMENT_SPAN)
    .at(-1);
  if (!span) throw new Error('no payment span');
  return { fromMppx, recorded: span.attributes['blockchain.tx.hash'], span };
}

describe("the payer's own hash", () => {
  it.each<[string, Case]>([
    ['a push credential', { mode: 'push' }],
    ['an unsponsored pull credential', { mode: 'pull' }],
    [
      'a sponsored pull credential (none: the fee payer signs later)',
      { mode: 'pull', sponsored: true },
    ],
    [
      'a signed transaction with trailing bytes',
      { mode: 'pull', change: withSignature((signature) => `${signature}00` as Hex) },
    ],
    [
      'a signed transaction with a nonce of non-minimal length',
      {
        mode: 'pull',
        change: withSignature((signature) =>
          changeTransaction(signature, (fields) =>
            fields.map(
              (field, index): Rlp => (index === 7 ? (field === '0x' ? '0x00' : field) : field),
            ),
          ),
        ),
      },
    ],
    [
      'a signed transaction with a chain id of non-minimal length',
      {
        mode: 'pull',
        change: withSignature((signature) =>
          changeTransaction(signature, (fields) =>
            fields.map((field, index) =>
              index === 0 ? (`0x00${(field as string).slice(2)}` as Hex) : field,
            ),
          ),
        ),
      },
    ],
    [
      'a transaction without its signature',
      {
        mode: 'pull',
        change: withSignature((signature) =>
          changeTransaction(signature, (fields) => fields.slice(0, 13) as Rlp[]),
        ),
      },
    ],
    [
      'a transaction that waits for a fee payer',
      {
        mode: 'pull',
        change: withSignature((signature) =>
          changeTransaction(signature, (fields) =>
            fields.map((field, index): Rlp => (index === 11 ? '0x00' : field)),
          ),
        ),
      },
    ],
    [
      'a transaction that names its fee payer by address',
      {
        mode: 'pull',
        change: withSignature((signature) =>
          changeTransaction(signature, (fields) =>
            fields.map((field, index): Rlp => (index === 11 ? `0x${'12'.repeat(20)}` : field)),
          ),
        ),
      },
    ],
    [
      'a transaction of another type',
      { mode: 'pull', change: withSignature((signature) => `0x02${signature.slice(4)}` as Hex) },
    ],
    [
      'a push credential whose hash is not one',
      {
        mode: 'push',
        change: (credential) =>
          recodeCredential(credential, (json) => {
            (json.payload as { hash: string }).hash = '0x1234';
          }),
      },
    ],
  ])('is the one mppx derives, for %s', async (_name, run) => {
    const { fromMppx, recorded, span } = await hashes(run);
    expect(fromMppx).not.toBe('not reported');
    expect(recorded).toBe(fromMppx);
    // With a hash, the outcome is pending; without one, the payment failed with mppx's error.
    expect(span.attributes['blockchain.payment.status']).toBe(
      fromMppx === undefined ? undefined : 'pending',
    );
    if (fromMppx === undefined)
      expect(span.attributes['error.type']).toBe('PaymentOutcomeUnknownError');
  });

  it('is derived for the real push, unsponsored and sponsored credentials as expected', async () => {
    expect((await hashes({ mode: 'push' })).recorded).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await hashes({ mode: 'pull' })).recorded).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await hashes({ mode: 'pull', sponsored: true })).recorded).toBeUndefined();
  });
});
