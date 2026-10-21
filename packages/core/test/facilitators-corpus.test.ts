// Tests the corpus of the facilitator conformance matrix (scripts/facilitators/) without Docker: the committed file
// is what the generator writes, every committed signature expired long before any run, and the expectations name the
// spec where it is explicit and nothing else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  addressOf,
  buildCase,
  buildCorpus,
  CASES,
  CHAIN_ID,
  CORPUS_FILE,
  corpusText,
  EXPIRY_LIMIT,
  FLOWS,
  NETWORK,
  PAY_TO,
  receiverOf,
  T0,
  typedDataOf,
} from '../../../scripts/facilitators/corpus.mjs';
import { KNOWN } from '../../../scripts/facilitators/diff.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const committedText = readFileSync(join(root, CORPUS_FILE), 'utf8');
const committed = JSON.parse(committedText);

type Payload = {
  accepted: { scheme: string; network: string };
  payload: {
    signature: `0x${string}`;
    authorization?: { from: string; validAfter: string; validBefore: string };
    permit2Authorization?: { from: string; deadline: string; witness: { validAfter: string } };
  };
};
type Expectation = {
  step?: number;
  field: string;
  kind: string;
  value?: unknown;
  ref?: string;
  known?: string;
};
type Case = {
  id: string;
  scheme: string;
  steps: string[];
  paymentPayload: Payload;
  expect: Expectation[];
};

/** Every payload of a corpus, with the id of its case. */
const payloads = (corpus: { cases: Case[] }) =>
  corpus.cases.map((c) => ({ id: c.id, payload: c.paymentPayload }));

describe('facilitator corpus', () => {
  it('is the committed file the generator writes at the fixed past time', async () => {
    expect(
      corpusText(await buildCorpus()),
      'run `node scripts/facilitators/corpus.mjs --write`',
    ).toBe(committedText);
    expect(committed.now).toBe(T0);
    expect(new Date(T0 * 1000).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(committed.chainId).toBe(CHAIN_ID);
    expect(committed.network).toBe(NETWORK);
  });

  it('holds only signatures whose validity ended before 2025-01-01', () => {
    expect(new Date(EXPIRY_LIMIT * 1000).toISOString()).toBe('2025-01-01T00:00:00.000Z');
    const ends = payloads(committed).map(({ id, payload }) => {
      const p = payload.payload;
      const end = p.authorization?.validBefore ?? p.permit2Authorization?.deadline;
      return { id, end: Number(end) };
    });
    expect(ends).toHaveLength(CASES.length);
    for (const { id, end } of ends) {
      expect({ id, finite: Number.isFinite(end) }).toEqual({ id, finite: true });
      expect({ id, expired: end < EXPIRY_LIMIT }).toEqual({ id, expired: true });
    }
  });

  it('is signed by the payer each payload names, except the bad signature', async () => {
    for (const { id, payload } of payloads(committed)) {
      const p = payload.payload;
      const from = (p.authorization ?? p.permit2Authorization)?.from as string;
      const signer = await recoverTypedDataAddress({
        ...typedDataOf(payload),
        signature: p.signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]);
      if (id === 'exact-eip3009-bad-signature') {
        expect(signer).toBe(addressOf(ACCOUNTS.stranger));
      } else {
        expect({ id, signer }).toEqual({ id, signer: from });
      }
    }
  });

  it('re-signs the same cases for a run, with windows around the run time', async () => {
    const now = 1_800_000_000;
    const run = await buildCorpus({ now, salt: 'run-1' });
    expect(run.cases.map((c: Case) => c.id)).toEqual(committed.cases.map((c: Case) => c.id));
    const authorization = (id: string) =>
      (run.cases as Case[]).find((c) => c.id === id)?.paymentPayload.payload.authorization;
    expect(Number(authorization('exact-eip3009-valid')?.validBefore)).toBe(now + 3600);
    expect(authorization('exact-eip3009-valid')?.validAfter).toBe('0');
    expect(Number(authorization('exact-eip3009-expired')?.validBefore)).toBe(now - 3600);
    // A new salt gives new nonces, so a fault case never replays a conformance case.
    const other = await buildCorpus({ now, salt: 'run-2' });
    const nonce = (c: { cases: Case[] }) =>
      (c.cases[0] as Case).paymentPayload.payload.authorization;
    expect(nonce(other)).not.toEqual(nonce(run));
  });

  it('gives a fault case a receiver of its own, in the requirements and in what is signed', async () => {
    const a = receiverOf('exact-eip3009-valid:eth_sendRawTransaction:drop');
    const b = receiverOf('exact-eip3009-valid:eth_sendRawTransaction:reset');
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(PAY_TO);
    for (const id of ['exact-eip3009-valid', 'exact-permit2-valid', 'upto-permit2-partial']) {
      const built = await buildCase(
        CASES.find((c: { id: string }) => c.id === id),
        { now: 1_800_000_000, salt: 's', payTo: a },
      );
      const p = built.paymentPayload.payload;
      expect(built.paymentRequirements.payTo).toBe(a);
      expect((p.authorization ?? p.permit2Authorization.witness).to).toBe(a);
    }
  });

  it('covers each scheme, the negatives and the batch-settlement flows', () => {
    expect(CASES.map((c: { id: string }) => c.id)).toEqual([
      'exact-eip3009-valid',
      'exact-eip3009-expired',
      'exact-eip3009-not-yet-valid',
      'exact-eip3009-amount-mismatch',
      'exact-eip3009-recipient-mismatch',
      'exact-eip3009-wrong-asset',
      'exact-eip3009-wrong-network',
      'exact-eip3009-insufficient-balance',
      'exact-eip3009-bad-signature',
      'exact-eip3009-replay',
      'exact-permit2-valid',
      'exact-permit2-expired',
      'upto-permit2-partial',
      'upto-permit2-exceeds',
      'exact-payload-as-upto',
    ]);
    expect(FLOWS.map((f: { id: string }) => f.id)).toEqual([
      'batch-refund-before-settle',
      'batch-flush-stop',
      'batch-dynamic-pricing',
    ]);
    for (const c of committed.cases as Case[]) {
      expect(c.steps[0]).toBe('verify');
      expect(c.paymentPayload.accepted.scheme).toBe(c.scheme);
    }
  });

  it('expects what the spec states, and only records the rest', () => {
    const all = [
      ...(committed.cases as Case[]).flatMap((c) => c.expect.map((e) => ({ id: c.id, ...e }))),
      ...(FLOWS as { id: string; expect: Expectation[] }[]).flatMap((f) =>
        f.expect.map((e) => ({ ...e, id: f.id })),
      ),
    ];
    expect(all.length).toBeGreaterThan(40);
    for (const e of all) {
      expect(['spec', 'unspecified']).toContain(e.kind);
      if (e.kind === 'spec') {
        expect({ id: e.id, field: e.field, value: 'value' in e }).toEqual({
          id: e.id,
          field: e.field,
          value: true,
        });
        expect(e.ref).toMatch(/^(x402-specification-v2|scheme_[a-z_]+)\.md /);
      } else {
        expect('value' in e).toBe(false);
      }
      if (e.known !== undefined) expect(KNOWN).toContain(e.known);
    }
    // Section 9 names these reasons; the research saw implementations return others for some of them.
    const reasons = Object.fromEntries(
      all
        .filter((e) => e.field === 'invalidReason' && e.kind === 'spec')
        .map((e) => [e.id, e.value]),
    );
    expect(reasons).toEqual({
      'exact-eip3009-expired': 'invalid_exact_evm_payload_authorization_valid_before',
      'exact-eip3009-not-yet-valid': 'invalid_exact_evm_payload_authorization_valid_after',
      'exact-eip3009-amount-mismatch': 'invalid_exact_evm_payload_authorization_value_mismatch',
      'exact-eip3009-recipient-mismatch': 'invalid_exact_evm_payload_recipient_mismatch',
      'exact-eip3009-insufficient-balance': 'insufficient_funds',
      'exact-eip3009-bad-signature': 'invalid_exact_evm_payload_signature',
    });
    // The refund case of x402#3730 is marked with that item only.
    expect(all.filter((e) => e.known).map((e) => [e.id, e.known])).toEqual([
      ['batch-refund-before-settle', 'x402#3730'],
    ]);
  });

  it('never calls anything a bug', () => {
    expect(committedText).not.toMatch(/\bbugs?\b/i);
    expect(JSON.stringify(FLOWS)).not.toMatch(/\bbugs?\b/i);
  });
});
