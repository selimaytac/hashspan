// Tests the corpus of the ERC-4337 bundler matrix (scripts/bundlers/) without Docker: the committed file is what the
// generator writes, every operation is signed for chain id 1337 by the key its case names, and the expectations cite
// ERC-7769 where it is explicit and nothing else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Hex, recoverMessageAddress } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
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
  ENTRY_POINTS,
  ERCS_COMMIT,
  FACTORY,
  FEES,
  FUNDS,
  feesFor,
  fundedSalts,
  fundsFor,
  HUGE_PRE_VERIFICATION_GAS,
  REF,
  SENDERS,
  saltsOf,
} from '../../../scripts/bundlers/corpus.mjs';
import { KNOWN } from '../../../scripts/bundlers/diff.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const committedText = readFileSync(join(root, CORPUS_FILE), 'utf8');
const committed = JSON.parse(committedText);

type Rpc = Record<string, Hex>;
type Built = {
  id: string;
  entryPoint: string;
  steps: { call: string; op: string }[];
  ops: Record<string, { hash: Hex; userOperation: Rpc }>;
  expect: {
    step?: number;
    field: string;
    kind: string;
    value?: unknown;
    ref?: string;
    known?: string;
  }[];
};
const cases = committed.cases as Built[];
const caseOf = (id: string) => cases.find((c) => c.id === id) as Built;

/** The hash of a committed operation, computed again from its fields. */
const hashOf = (rpc: Rpc) =>
  getUserOperationHash({
    chainId: CHAIN_ID,
    entryPointAddress: ENTRY_POINTS['0.7'],
    entryPointVersion: '0.7',
    userOperation: {
      sender: rpc.sender as Hex,
      nonce: BigInt(rpc.nonce as Hex),
      factory: rpc.factory,
      factoryData: rpc.factoryData,
      callData: rpc.callData as Hex,
      callGasLimit: BigInt(rpc.callGasLimit as Hex),
      verificationGasLimit: BigInt(rpc.verificationGasLimit as Hex),
      preVerificationGas: BigInt(rpc.preVerificationGas as Hex),
      maxFeePerGas: BigInt(rpc.maxFeePerGas as Hex),
      maxPriorityFeePerGas: BigInt(rpc.maxPriorityFeePerGas as Hex),
      signature: rpc.signature as Hex,
    },
  });

describe('bundler corpus', () => {
  it('signs fault-pass operations with fees from the chain, never below the corpus fees', () => {
    const gwei = 10n ** 9n;
    // A fresh chain: the corpus fees stay.
    expect(feesFor({ baseFee: gwei, suggestedPriority: gwei / 2n })).toEqual(FEES);
    // The node now suggests more than the corpus tip (what made Voltaire refuse the fixed fees).
    const raised = feesFor({ baseFee: 30n * gwei, suggestedPriority: 3n * gwei });
    expect(raised.maxPriorityFeePerGas).toBe(6n * gwei);
    expect(raised.maxFeePerGas).toBe(66n * gwei);
    expect(raised.maxFeePerGas >= raised.maxPriorityFeePerGas).toBe(true);
  });

  it('funds a sender for twice the most its operation can be charged, never below FUNDS', () => {
    const op = (maxFeePerGas: bigint) => ({
      callGasLimit: '0x186a0',
      verificationGasLimit: '0x927c0',
      preVerificationGas: '0x186a0',
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
    });
    const gwei = 10n ** 9n;
    expect(fundsFor(op(20n * gwei))).toBe(FUNDS);
    // 800,000 gas at 2,000 gwei is 1.6 ETH; twice that is funded.
    expect(fundsFor(op(2_000n * gwei))).toBe(2n * 800_000n * 2_000n * gwei);
  });

  it('builds a case with the fees it is given, and the corpus with FEES', async () => {
    const c = CASES.find((x: { id: string }) => x.id === 'plain-op');
    const fees = { maxFeePerGas: 77n * 10n ** 9n, maxPriorityFeePerGas: 7n * 10n ** 9n };
    const built = await buildCase(c, { fees });
    expect(BigInt(built.ops.main.userOperation.maxFeePerGas)).toBe(fees.maxFeePerGas);
    expect(BigInt(built.ops.main.userOperation.maxPriorityFeePerGas)).toBe(
      fees.maxPriorityFeePerGas,
    );
    const corpus = await buildCase(c);
    expect(BigInt(corpus.ops.main.userOperation.maxFeePerGas)).toBe(FEES.maxFeePerGas);
  });

  it('is the committed file the generator writes', async () => {
    expect(corpusText(await buildCorpus()), 'run `node scripts/bundlers/corpus.mjs --write`').toBe(
      committedText,
    );
    expect(committed.chainId).toBe(1337);
    expect(committed.entryPoint).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
    expect(committed.factory).toBe(FACTORY);
    expect(committed.ercsCommit).toBe(ERCS_COMMIT);
  });

  it('has the cases of the design, each with an account of its own', () => {
    expect(CASES.map((c: { id: string }) => c.id)).toEqual([
      'plain-op',
      'batch-calls',
      'two-senders',
      'execution-revert',
      'bad-signature',
      'validation-revert',
      'insufficient-prefund',
      'low-verification-gas',
      'nonce-reuse',
      'nonce-gap',
      'replacement',
      'pre-verification-gas-out-of-range',
    ]);
    // A salt is shared only within one case (a reuse or a replacement of the same sender).
    const owners = new Map<number, string>();
    for (const c of CASES) {
      for (const op of Object.values(c.ops) as { salt: number }[]) {
        expect(owners.get(op.salt) ?? c.id, `salt ${op.salt}`).toBe(c.id);
        owners.set(op.salt, c.id);
      }
    }
    expect(Object.keys(SENDERS).map(Number)).toEqual(saltsOf());
    expect(fundedSalts()).not.toContain(8);
    for (const c of cases) expect(c.entryPoint).toBe('0.7');
  });

  it('builds every operation for the sender of its salt, with the hash its fields give', () => {
    for (const c of cases) {
      for (const [name, op] of Object.entries(c.ops)) {
        const salt = (
          CASES.find((x: { id: string }) => x.id === c.id).ops[name] as { salt: number }
        ).salt;
        expect(op.userOperation.sender).toBe(SENDERS[salt]);
        expect(op.hash).toBe(hashOf(op.userOperation));
      }
    }
  });

  it('signs each operation with the key its case names, for chain id 1337 only', async () => {
    const signer = async (rpc: Rpc) =>
      recoverMessageAddress({ message: { raw: hashOf(rpc) }, signature: rpc.signature as Hex });
    expect(await signer(caseOf('plain-op').ops.main?.userOperation as Rpc)).toBe(
      addressOf(ACCOUNTS.owner),
    );
    expect(await signer(caseOf('bad-signature').ops.main?.userOperation as Rpc)).toBe(
      addressOf(ACCOUNTS.stranger),
    );
    expect(caseOf('validation-revert').ops.main?.userOperation.signature).toBe('0x1234');
  });

  it('makes each negative differ from a valid operation in the one field it is about', () => {
    const rpc = (id: string, name = 'main') => caseOf(id).ops[name]?.userOperation as Rpc;
    expect(BigInt(rpc('low-verification-gas').verificationGasLimit as Hex)).toBe(20_000n);
    expect(BigInt(rpc('pre-verification-gas-out-of-range').preVerificationGas as Hex)).toBe(
      HUGE_PRE_VERIFICATION_GAS,
    );
    expect(BigInt(rpc('nonce-gap').nonce as Hex)).toBe(1n);
    expect(rpc('nonce-gap').factory).toBe(FACTORY);
    expect(rpc('nonce-reuse', 'reuse').factory).toBeUndefined();
    expect(rpc('nonce-reuse', 'reuse').sender).toBe(rpc('nonce-reuse', 'first').sender);
    const first = rpc('replacement', 'first');
    const replacement = rpc('replacement', 'replacement');
    expect(replacement.nonce).toBe(first.nonce);
    expect(BigInt(replacement.maxFeePerGas as Hex) * 2n).toBe(
      BigInt(first.maxFeePerGas as Hex) * 3n,
    );
    expect(caseOf('batch-calls').ops.main?.userOperation.callData?.slice(0, 10)).toBe('0x47e1da2a');
  });

  it('cites ERC-7769 at its pinned commit in every spec row, and leaves -32506 unspecified', () => {
    for (const c of CASES) {
      for (const e of c.expect) {
        if (e.kind === 'spec') {
          expect(e.ref, `${c.id} ${e.field}`).toMatch(/^erc-7769\.md:\d+(-\d+)?@a431a3fb$/);
          expect(Object.values(REF)).toContain(e.ref);
        } else {
          expect(e.kind).toBe('unspecified');
          expect(e.ref).toBeUndefined();
        }
        if (e.field === 'code' && e.kind === 'spec')
          expect([-32602, -32500, -32507]).toContain(e.value);
        expect(e.value).not.toBe(-32506);
      }
    }
    expect(REF.signature).toBe('erc-7769.md:86@a431a3fb');
    expect(REF.receipt).toBe('erc-7769.md:247-260@a431a3fb');
  });

  it('marks known only the rundler#1354 row, naming an upstream item', () => {
    const marks = CASES.flatMap((c: { id: string; expect: { known?: string }[] }) =>
      c.expect.filter((e) => e.known).map((e) => ({ id: c.id, known: e.known })),
    );
    expect(marks).toEqual([{ id: 'pre-verification-gas-out-of-range', known: 'rundler#1354' }]);
    for (const k of KNOWN) expect(k).toMatch(/^[a-z0-9-]+#\d+$/);
    expect(committedText).not.toMatch(/\bbugs?\b/i);
  });

  it('builds the fault pass operations for accounts of their own, from the senders the chain gives', async () => {
    const plain = CASES.find((c: { id: string }) => c.id === 'plain-op');
    const asked: number[] = [];
    const built = await buildCase(plain, {
      saltOffset: 1000,
      senderOf: async (salt: number) => {
        asked.push(salt);
        return SENDERS[1];
      },
    });
    expect(asked).toEqual([1001]);
    expect(built.ops.main?.hash).not.toBe(caseOf('plain-op').ops.main?.hash);
  });
});
