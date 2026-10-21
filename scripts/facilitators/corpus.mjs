// The corpus of the facilitator conformance matrix: x402 v2 payment payloads signed with Anvil's well-known keys for
// chain id 84532, each with the /verify and /settle results the spec states, and the batch-settlement flows a run
// drives through the SDK's channel manager.
//
// The committed file (corpus.json) is signed at a fixed past time, 2024-01-01, so every signature in it expired long
// before any run and is of no use on a real chain: Permit2 sits at the same address on Base Sepolia. The facilitators
// judge a validity window by their host clock (TypeScript `Date.now()`, Go `time.Now()`, Python `time.time()` in the
// exact EVM verifiers of the pinned commit), so a run signs the same cases again in memory with windows around its
// own time; those payloads never reach a file. A result holds what the facilitator answered, never a payload.
//
// Usage: node scripts/facilitators/corpus.mjs           (prints the corpus)
//        node scripts/facilitators/corpus.mjs --write   (rewrites corpus.json)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, getContractAddress, hexToBigInt, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  EXACT_PROXY_ADDRESS,
  PERMIT2_ADDRESS,
  UPTO_PROXY_ADDRESS,
} from '../../packages/x402/test/permit2/contracts.ts';

/** Id of the corpus, recorded in every result. */
export const CORPUS_ID = 'x402-v2-anvil-1';
/** The committed corpus, relative to the repository root. */
export const CORPUS_FILE = 'scripts/facilitators/corpus.json';
/** One chain id for every target: the TypeScript facilitator maps every network but Base to viem's `baseSepolia`. */
export const CHAIN_ID = 84532;
export const NETWORK = `eip155:${CHAIN_ID}`;
/** The time the committed corpus is signed at, and Anvil's genesis time: 2024-01-01T00:00:00Z. */
export const T0 = 1_704_067_200;
/** Every committed signature's validity ends before this time: 2025-01-01T00:00:00Z. */
export const EXPIRY_LIMIT = 1_735_689_600;
/** Length of a validity window, in seconds. */
export const WINDOW = 3600;

/**
 * Anvil's well-known test keys (mnemonic `test test ... junk`), by role. The deployer is unlocked on the node and sets
 * the chain up; the facilitator key goes to the facilitator by env name; the others sign payments.
 */
export const ACCOUNTS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  facilitator: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  unfunded: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  stranger: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  batchRefund: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  batchFlush: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  batchDynamic: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
};

/** The address of one of the keys. */
export const addressOf = (key) => privateKeyToAccount(key).address;

/** The receiver of every payment; no key. */
export const PAY_TO = '0x00000000000000000000000000000000000000cc';
/** An address that is neither the receiver nor the token: the wrong recipient and the wrong asset. */
export const OTHER = '0x00000000000000000000000000000000000000dd';
/** The price of a case, in the token's smallest unit. */
export const AMOUNT = '10000';
/** What an upto case settles of its authorized maximum, and what an exceeding settle asks for. */
export const UPTO_CHARGE = '4000';
export const UPTO_EXCESS = '12000';
/** Tokens minted to every funded payer. */
export const FUNDS = 1_000_000n;
/** The token: TestUsd (packages/x402/test/token), the deployer's first contract on a fresh Anvil. */
export const TOKEN = getContractAddress({ from: addressOf(ACCOUNTS.deployer), nonce: 0n });
export const TOKEN_DOMAIN = { name: 'Test USD', version: '1' };
export { EXACT_PROXY_ADDRESS, PERMIT2_ADDRESS, UPTO_PROXY_ADDRESS };

// Where the spec states an expectation. A `spec` row cites one; an `unspecified` row is only recorded and compared
// across targets.
const SPEC = 'x402-specification-v2.md';
const EXACT = 'scheme_exact_evm.md';
const UPTO = 'scheme_upto_evm.md';
const BATCH = 'scheme_batch_settlement_evm.md';
const ref = {
  errors: `${SPEC} §9`,
  settle: `${SPEC} §5.3.2`,
  verify: `${SPEC} §5.4.2`,
  replay: `${SPEC} §10.1`,
  signature: `${EXACT} §1 Phase 2 step 1`,
  balance: `${EXACT} §1 Phase 2 step 2`,
  parameters: `${EXACT} §1 Phase 2 step 3`,
  token: `${EXACT} §1 Phase 2 step 4`,
  simulate: `${EXACT} §1 Phase 2 step 5`,
  transfer: `${EXACT} §1 Phase 3`,
  permit2: `${EXACT} §2 Phase 3`,
  permit2Settle: `${EXACT} §2 Phase 4`,
  uptoSettle: `${UPTO} §1 Phase 4`,
  uptoErrors: `${UPTO} §4`,
  batchSettle: `${BATCH} Claim and settle`,
};

const spec = (field, value, reference, step) => ({
  ...(step === undefined ? {} : { step }),
  field,
  kind: 'spec',
  value,
  ref: reference,
});
const unspecified = (field, step) => ({
  ...(step === undefined ? {} : { step }),
  field,
  kind: 'unspecified',
});

/** What a payment that settles states: valid, settled with a transaction, the amount moved. */
const settles = (moved, transferRef) => [
  spec('isValid', true, ref.verify, 0),
  spec('success', true, ref.settle, 1),
  spec('transaction', 'present', ref.settle, 1),
  spec('effect.payTo', moved, transferRef),
  spec('effect.payer', `-${moved}`, transferRef),
];

/** What a payment that fails verification states, with the reason section 9 names, when it names one. */
const rejected = (because, reason) => [
  spec('isValid', false, because, 0),
  reason === undefined
    ? unspecified('invalidReason', 0)
    : spec('invalidReason', reason, ref.errors, 0),
  unspecified('success', 1),
  unspecified('errorReason', 1),
  unspecified('effect.payTo'),
];

/**
 * The cases: `transfer` is the asset transfer method, `window` the validity window relative to the run's time,
 * `change` what a negative changes, `steps` the calls in order (default verify, then settle).
 */
export const CASES = [
  {
    id: 'exact-eip3009-valid',
    scheme: 'exact',
    transfer: 'eip3009',
    expect: settles(AMOUNT, ref.transfer),
  },
  {
    id: 'exact-eip3009-expired',
    scheme: 'exact',
    transfer: 'eip3009',
    window: 'expired',
    expect: rejected(ref.parameters, 'invalid_exact_evm_payload_authorization_valid_before'),
  },
  {
    id: 'exact-eip3009-not-yet-valid',
    scheme: 'exact',
    transfer: 'eip3009',
    window: 'not-yet-valid',
    expect: rejected(ref.parameters, 'invalid_exact_evm_payload_authorization_valid_after'),
  },
  {
    id: 'exact-eip3009-amount-mismatch',
    scheme: 'exact',
    transfer: 'eip3009',
    change: { value: '9999' },
    expect: rejected(ref.parameters, 'invalid_exact_evm_payload_authorization_value_mismatch'),
  },
  {
    id: 'exact-eip3009-recipient-mismatch',
    scheme: 'exact',
    transfer: 'eip3009',
    change: { to: OTHER },
    expect: rejected(ref.parameters, 'invalid_exact_evm_payload_recipient_mismatch'),
  },
  {
    id: 'exact-eip3009-wrong-asset',
    scheme: 'exact',
    transfer: 'eip3009',
    change: { asset: OTHER },
    expect: rejected(ref.token),
  },
  {
    id: 'exact-eip3009-wrong-network',
    scheme: 'exact',
    transfer: 'eip3009',
    change: { network: 'eip155:1' },
    expect: rejected(ref.token),
  },
  {
    id: 'exact-eip3009-insufficient-balance',
    scheme: 'exact',
    transfer: 'eip3009',
    payer: 'unfunded',
    expect: rejected(ref.balance, 'insufficient_funds'),
  },
  {
    id: 'exact-eip3009-bad-signature',
    scheme: 'exact',
    transfer: 'eip3009',
    change: { signer: 'stranger' },
    expect: rejected(ref.signature, 'invalid_exact_evm_payload_signature'),
  },
  {
    id: 'exact-eip3009-replay',
    scheme: 'exact',
    transfer: 'eip3009',
    steps: ['verify', 'settle', 'verify', 'settle'],
    expect: [
      spec('isValid', true, ref.verify, 0),
      spec('success', true, ref.settle, 1),
      spec('isValid', false, ref.simulate, 2),
      unspecified('invalidReason', 2),
      spec('success', false, ref.replay, 3),
      unspecified('errorReason', 3),
      spec('effect.payTo', AMOUNT, ref.replay),
    ],
  },
  {
    id: 'exact-permit2-valid',
    scheme: 'exact',
    transfer: 'permit2',
    expect: settles(AMOUNT, ref.permit2Settle),
  },
  {
    id: 'exact-permit2-expired',
    scheme: 'exact',
    transfer: 'permit2',
    window: 'expired',
    expect: rejected(ref.permit2),
  },
  {
    id: 'upto-permit2-partial',
    scheme: 'upto',
    transfer: 'permit2',
    settleAmount: UPTO_CHARGE,
    expect: settles(UPTO_CHARGE, ref.uptoSettle),
  },
  {
    id: 'upto-permit2-exceeds',
    scheme: 'upto',
    transfer: 'permit2',
    settleAmount: UPTO_EXCESS,
    expect: [
      spec('isValid', true, ref.verify, 0),
      spec('success', false, ref.uptoSettle, 1),
      spec('errorReason', 'invalid_upto_evm_payload_settlement_exceeds_amount', ref.uptoErrors, 1),
      spec('effect.payTo', '0', ref.uptoSettle),
    ],
  },
  {
    id: 'exact-payload-as-upto',
    scheme: 'upto',
    transfer: 'eip3009',
    expect: [
      unspecified('isValid', 0),
      unspecified('invalidReason', 0),
      unspecified('success', 1),
      unspecified('effect.payTo'),
    ],
  },
];

/**
 * The batch-settlement flows (E5), driven at run time through the SDK's client, resource server and channel manager
 * against the target's /verify and /settle (flows.mjs): `requests` paid requests of `price`, each charged `charge`,
 * then what the server does (`server`). The refund-before-settle flow is x402#3730: the channel manager of the pinned SDK
 * leaves the charged amount in the contract after a refund, until x402#3858 lands.
 */
export const FLOWS = [
  {
    id: 'batch-refund-before-settle',
    scheme: 'batch-settlement',
    payer: 'batchRefund',
    requests: 3,
    price: '1000',
    server: ['refund', 'claimAndSettle'],
    expect: [
      { ...spec('effect.payTo', '3000', ref.batchSettle), known: 'x402#3730' },
      unspecified('effect.payer'),
      unspecified('effect.contract'),
    ],
  },
  {
    id: 'batch-flush-stop',
    scheme: 'batch-settlement',
    payer: 'batchFlush',
    requests: 3,
    price: '1000',
    server: ['stopWithFlush'],
    expect: [
      unspecified('effect.payTo'),
      unspecified('effect.payer'),
      unspecified('effect.contract'),
    ],
  },
  {
    id: 'batch-dynamic-pricing',
    scheme: 'batch-settlement',
    payer: 'batchDynamic',
    requests: 3,
    price: '1000',
    charge: '50%',
    server: ['claimAndSettle'],
    expect: [
      unspecified('effect.payTo'),
      unspecified('effect.payer'),
      unspecified('effect.contract'),
    ],
  },
];

/** A 32-byte value derived from the case, so payloads are the same for the same time and salt. */
const derived = (...parts) => keccak256(toHex([CORPUS_ID, ...parts].join(':')));

/** validAfter and validBefore (or Permit2's deadline) of a window, relative to `now`. */
function windowOf(kind = 'valid', now) {
  if (kind === 'expired') return { after: 0, before: now - WINDOW };
  if (kind === 'not-yet-valid') return { after: now + WINDOW, before: now + 2 * WINDOW };
  return { after: 0, before: now + WINDOW };
}

/** The payment requirements a case is paid against. */
function requirementsOf(c) {
  const network = c.change?.network ?? NETWORK;
  const extra =
    c.transfer === 'permit2'
      ? { ...TOKEN_DOMAIN, assetTransferMethod: 'permit2' }
      : { ...TOKEN_DOMAIN, assetTransferMethod: 'eip3009' };
  if (c.scheme === 'upto') extra.facilitatorAddress = addressOf(ACCOUNTS.facilitator);
  return {
    scheme: c.scheme,
    network,
    amount: AMOUNT,
    asset: c.change?.asset ?? TOKEN,
    payTo: PAY_TO,
    maxTimeoutSeconds: WINDOW,
    extra,
  };
}

/** The EIP-712 data a payload's signature covers, as the payer signs it; for checks of the committed file. */
export function typedDataOf(paymentPayload) {
  const { payload } = paymentPayload;
  // Signed for the matrix chain, also when a case's requirements name another network.
  if (payload.authorization) {
    const a = payload.authorization;
    return {
      domain: { ...TOKEN_DOMAIN, chainId: CHAIN_ID, verifyingContract: TOKEN },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(a.from),
        to: getAddress(a.to),
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
    };
  }
  const p = payload.permit2Authorization;
  const upto = p.witness.facilitator !== undefined;
  return {
    domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'Witness' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      Witness: [
        { name: 'to', type: 'address' },
        ...(upto ? [{ name: 'facilitator', type: 'address' }] : []),
        { name: 'validAfter', type: 'uint256' },
      ],
    },
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: getAddress(p.permitted.token), amount: BigInt(p.permitted.amount) },
      spender: getAddress(p.spender),
      nonce: BigInt(p.nonce),
      deadline: BigInt(p.deadline),
      witness: {
        to: getAddress(p.witness.to),
        ...(upto ? { facilitator: getAddress(p.witness.facilitator) } : {}),
        validAfter: BigInt(p.witness.validAfter),
      },
    },
  };
}

/** The `payload` of a case's payment payload, signed for the window around `now`. */
async function payloadOf(c, requirements, now, salt) {
  const payer = privateKeyToAccount(ACCOUNTS[c.payer ?? 'payer']);
  const signer = privateKeyToAccount(ACCOUNTS[c.change?.signer ?? c.payer ?? 'payer']);
  const { after, before } = windowOf(c.window, now);
  if (c.transfer === 'eip3009') {
    const authorization = {
      from: payer.address,
      to: getAddress(c.change?.to ?? PAY_TO),
      value: c.change?.value ?? AMOUNT,
      validAfter: String(after),
      validBefore: String(before),
      nonce: derived(c.id, salt),
    };
    return {
      authorization,
      signature: await signer.signTypedData(typedDataOf({ payload: { authorization } })),
    };
  }
  const upto = c.scheme === 'upto';
  const permit2Authorization = {
    from: payer.address,
    permitted: { token: getAddress(requirements.asset), amount: AMOUNT },
    spender: upto ? UPTO_PROXY_ADDRESS : EXACT_PROXY_ADDRESS,
    nonce: hexToBigInt(derived(c.id, salt)).toString(),
    deadline: String(before),
    witness: {
      to: getAddress(c.change?.to ?? PAY_TO),
      ...(upto ? { facilitator: addressOf(ACCOUNTS.facilitator) } : {}),
      validAfter: String(after),
    },
  };
  const signature = await signer.signTypedData(typedDataOf({ payload: { permit2Authorization } }));
  return { signature, permit2Authorization };
}

/**
 * One case, signed for the window around `now`: its payload, requirements, calls and expectations. `salt`
 * gives the payloads nonces of their own, so a run can repeat a case without replaying it.
 */
export async function buildCase(c, { now = T0, salt = '' } = {}) {
  const requirements = requirementsOf(c);
  const paymentPayload = {
    x402Version: 2,
    resource: {
      url: 'http://api.test/weather',
      description: 'Weather',
      mimeType: 'application/json',
    },
    accepted: requirements,
    payload: await payloadOf(c, requirements, now, salt),
  };
  const settle =
    c.settleAmount === undefined
      ? {}
      : { settleRequirements: { ...requirements, amount: c.settleAmount } };
  return {
    id: c.id,
    scheme: c.scheme,
    transfer: c.transfer,
    steps: c.steps ?? ['verify', 'settle'],
    paymentPayload,
    paymentRequirements: requirements,
    ...settle,
    expect: c.expect,
  };
}

/** The request body of one call of a built case: an upto settle carries the amount to settle. */
export function bodyOf(built, call) {
  const paymentRequirements =
    call === 'settle' && built.settleRequirements
      ? built.settleRequirements
      : built.paymentRequirements;
  return { x402Version: 2, paymentPayload: built.paymentPayload, paymentRequirements };
}

/** The corpus at `now`: T0 for the committed file, the run's time for a run. */
export async function buildCorpus({ now = T0, salt = '' } = {}) {
  const cases = [];
  for (const c of CASES) cases.push(await buildCase(c, { now, salt }));
  return { id: CORPUS_ID, chainId: CHAIN_ID, network: NETWORK, now, token: TOKEN, cases };
}

/** The text of the corpus file: two-space JSON with a final newline. */
export const corpusText = (corpus) => `${JSON.stringify(corpus, null, 2)}\n`;

/** SHA-256 of the committed corpus file, recorded in every result. */
export function corpusHash(root) {
  return createHash('sha256')
    .update(readFileSync(join(root, CORPUS_FILE)))
    .digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const text = corpusText(await buildCorpus());
  if (process.argv.includes('--write')) writeFileSync(join(root, CORPUS_FILE), text);
  else process.stdout.write(text);
}
