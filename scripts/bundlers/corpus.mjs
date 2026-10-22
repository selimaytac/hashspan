// The corpus of the ERC-4337 bundler matrix: user operations for EntryPoint v0.7 from SimpleAccount smart accounts of
// Anvil's well-known keys on chain id 1337, built and signed with permissionless's `toSimpleSmartAccount` (offline:
// the sender comes from the table below and the chain id from the chain), each with what ERC-7769 states about the
// answer where it states it.
//
// The chain is the E1 setup (chain.mjs): the canonical EntryPoint v0.7 and SimpleAccountFactory deployed through the
// deterministic deployer, so the factory and every sender are at fixed addresses on a fresh Anvil. A test on Anvil
// checks the table against the factory and lands the plain operation through a direct `handleOps`.
//
// The committed file (corpus.json) holds the operations a conformance pass sends as they are: they are signed for chain
// id 1337 only and pay with fixed fees well above a fresh Anvil's base fee. The fault pass builds the same operations
// again in memory for accounts of its own (`salt`), so a fault case never shares a nonce with another case. A result
// holds what the bundler answered, never an operation or a signature.
//
// Usage: node scripts/bundlers/corpus.mjs           (prints the corpus)
//        node scripts/bundlers/corpus.mjs --write   (rewrites corpus.json)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSimpleSmartAccount } from 'permissionless/accounts';
import { getAddress, parseGwei } from 'viem';
import {
  entryPoint07Address,
  formatUserOperationRequest,
  getUserOperationHash,
} from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';

/** Id of the corpus, recorded in every result. */
export const CORPUS_ID = 'erc4337-v07-anvil-1';
/** The committed corpus, relative to the repository root. */
export const CORPUS_FILE = 'scripts/bundlers/corpus.json';
/** One chain id for every target: Rundler's `dev` network (bin/rundler/chain_specs/dev.toml:4 at v0.11.0). */
export const CHAIN_ID = 1337;

/** The canonical EntryPoints by version; v1 deploys v0.7 only, a target listing another one runs no row of it. */
export const ENTRY_POINTS = {
  0.6: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  0.7: entryPoint07Address,
  0.8: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
  0.9: '0x433709009B8330FDa32311DF1C2AFA402eD8D009',
};

/** The deterministic deployer Anvil ships with, and the salt EntryPoint v0.7 was deployed with on every chain. */
export const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const ENTRY_POINT_SALT =
  '0x90d8084deab30c2a37c45e8d47f49f2f7965183cb6990a98943ef94940681de3';

/**
 * SimpleAccountFactory v0.7 (@account-abstraction/contracts 0.7.0) for EntryPoint v0.7, deployed through the
 * deterministic deployer with a zero salt; checked on Anvil by bundlers-corpus.int.test.ts.
 */
export const FACTORY = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985';

/**
 * Anvil's well-known test keys (mnemonic `test test ... junk`), by role. The deployer is unlocked on the node and sets
 * the chain up; the executor signs the bundles and the utility key deploys Alto's simulation contract, both handed to
 * the bundler by env name only; the owner signs the operations, the stranger signs the bad one; the direct key sends
 * the Anvil test's own handleOps. Each role has its own key, so no two senders share a nonce.
 */
export const ACCOUNTS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  executor: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  owner: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  stranger: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  utility: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  direct: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
};

/** The address of one of the keys. */
export const addressOf = (key) => privateKeyToAccount(key).address;

/** The receiver of every transfer; no key. */
export const RECIPIENT = '0x00000000000000000000000000000000000000cc';
/** A contract whose every call reverts with `Error("boom")` (packages/viem/test/entry-point), set by chain.mjs. */
export const REVERTER = '0x00000000000000000000000000000000000000a1';

/**
 * The sender of the owner's SimpleAccount with each salt the committed corpus uses: `factory.getAddress(owner, salt)`,
 * checked on Anvil. The fault pass reads the senders of its own salts from the factory.
 */
/** @type {Record<number, string>} */
export const SENDERS = {
  1: '0xE35b1E23D30eE88b357AB51f10E75b02bcFa7ae6',
  2: '0x0630D1E3A9775a11663bA147746d63cbc1BAcBb5',
  3: '0x3CF0F2453559A8d8B104E842480C01Ca5cF6c549',
  4: '0x5E764d682b87F3191FB57E630AE68733D2b15a6C',
  5: '0x031Bf3Dca4D59f8421ddA95ff8c4612c62cB6548',
  6: '0xc8332B5C43dabf32D63F5A1b4865f6bE467BDd82',
  7: '0x3BD9468107211E5BA99E8813A3330D5677D397d4',
  8: '0x63d16db1D1C0e2f0f8693E8bC8206B1bACaE05a5',
  9: '0x9Fc1d7e91A9c1CB95502A8B1d217c3B2cE06422d',
  10: '0x1322f01b4a7420Cad8D3E1981336aff53A4e6885',
  11: '0x8359863719aaB8CBfD36cF62fd7B4A74b5d1625f',
  12: '0x06Db79CDBCF3e9b70D622dfb2490E933b230aDE4',
  13: '0x1220afB1795abF57F5B4E38f58a9Ba38e425EB20',
};

/** The fees of every operation: well above the base fee of a fresh Anvil (1 gwei and falling). */
export const FEES = { maxFeePerGas: parseGwei('20'), maxPriorityFeePerGas: parseGwei('2') };
/**
 * The fees of an operation signed during a run, from the chain at that time: at least FEES, a priority fee of twice
 * the node's suggestion and a max fee of twice the base fee plus that priority. A bundler that checks fees against
 * the node's current gas price (Voltaire: `estimated basefee + maxPriorityFeePerGas` against `eth_gasPrice` less its
 * tolerance, voltaire_bundler/gas/gas_manager.py) refuses the fixed FEES once the node's suggestion has risen above
 * them during a run. The committed corpus keeps FEES.
 * @param {{ baseFee: bigint, suggestedPriority: bigint }} chain
 */
export function feesFor({ baseFee, suggestedPriority }) {
  const max = (a, b) => (a > b ? a : b);
  const maxPriorityFeePerGas = max(FEES.maxPriorityFeePerGas, 2n * suggestedPriority);
  return {
    maxPriorityFeePerGas,
    maxFeePerGas: max(FEES.maxFeePerGas, 2n * baseFee + maxPriorityFeePerGas),
  };
}

/**
 * What an operation's sender needs to hold: at least FUNDS, and twice the most the EntryPoint can charge it (its gas
 * limits times its max fee). Fees taken from the chain can rise far during a run, as a bundler that reprices its bundle
 * transactions pushes the node's fee suggestion up, and a sender funded with FUNDS alone then fails with AA21.
 * @param {Record<string, string>} userOperation in RPC form (hex quantities)
 */
export function fundsFor(userOperation) {
  const gas = ['callGasLimit', 'verificationGasLimit', 'preVerificationGas'].reduce(
    (sum, key) => sum + BigInt(userOperation[key] ?? '0x0'),
    0n,
  );
  const needed = 2n * gas * BigInt(userOperation.maxFeePerGas);
  return needed > FUNDS ? needed : FUNDS;
}

/** The higher fees of a replacement: 50 percent above FEES, beyond any replacement threshold of the targets. */
export const REPLACEMENT_FEES = {
  maxFeePerGas: parseGwei('30'),
  maxPriorityFeePerGas: parseGwei('3'),
};
/** Fixed gas limits, generous for a SimpleAccount that deploys itself, so every target gets the same operation. */
export const GAS = {
  callGasLimit: 100_000n,
  verificationGasLimit: 600_000n,
  preVerificationGas: 100_000n,
};
/** A verification gas limit too low to deploy the account. */
export const LOW_VERIFICATION_GAS = 20_000n;
/** A preVerificationGas above 2^128 - 1, which a u128 cannot hold (rundler#1354). */
export const HUGE_PRE_VERIFICATION_GAS = 2n ** 128n;
/** What each funded sender gets: far more than its prefund, (100k + 600k + 100k) gas at 30 gwei. */
export const FUNDS = 10n ** 18n;

// Where ERC-7769 states an expectation, by line of ERCS/erc-7769.md at the ERCs commit below, the last change of that
// file (2025-03-02). A `spec` row cites one; an `unspecified` row is only recorded and compared across targets.
export const ERCS_COMMIT = 'a431a3fb66c1f31fa5394893003f7b9bb61c54bf';
const at = (lines) => `erc-7769.md:${lines}@${ERCS_COMMIT.slice(0, 8)}`;
export const REF = {
  accepted: at('66'),
  failure: at('67'),
  invalidFields: at('69'),
  simulateValidation: at('70-72'),
  signature: at('86'),
  estimate: at('201-207'),
  byHash: at('228-229'),
  receipt: at('247-260'),
  receiptSuccess: at('256'),
  receiptReason: at('257'),
  receiptLogs: at('258'),
  receiptBundle: at('259-260'),
  chainId: at('287-289'),
};

const spec = (step, field, value, ref, extra = {}) => ({
  step,
  field,
  kind: 'spec',
  value,
  ref,
  ...extra,
});
const unspecified = (step, field, extra = {}) => ({ step, field, kind: 'unspecified', ...extra });

/** What a valid operation states: the hash at send, then a receipt of the shape and values the chain shows. */
const lands = (send, wait, { success = true } = {}) => [
  spec(send, 'accepted', true, REF.accepted),
  spec(wait, 'included', true, REF.receipt),
  spec(wait, 'receipt.shape', 'complete', REF.receipt, { when: 'included' }),
  spec(wait, 'receipt.matchesChain', true, REF.receipt, { when: 'included' }),
  spec(wait, 'receipt.success', success, REF.receiptSuccess, { when: 'included' }),
  spec(wait, 'receipt.logsOwn', true, REF.receiptLogs, { when: 'included' }),
  spec(wait, 'receipt.bundleReceipt', 'whole-bundle', REF.receiptBundle, { when: 'included' }),
  spec(wait, 'byHash.matchesChain', true, REF.byHash, { when: 'included' }),
  unspecified(wait, 'receipt.paymaster', { when: 'included' }),
  unspecified(wait, 'receipt.reason', { when: 'included' }),
];

/** What a rejected operation states: an error object, with the code and `AAxx` message where ERC-7769 names them. */
const rejected = (step, { code, codeRef, aa } = {}) => [
  spec(step, 'accepted', false, REF.failure),
  code === undefined ? unspecified(step, 'code') : spec(step, 'code', code, codeRef),
  aa === undefined ? unspecified(step, 'aa') : spec(step, 'aa', aa, REF.simulateValidation),
];

/**
 * The cases. `ops` names each operation of a case: `salt` picks the owner's account (its own per case), `nonce` the
 * EntryPoint nonce, `deploy` whether it carries the factory (default: when the nonce is 0), `calls` what it executes,
 * `signer` who signs (`owner`, `stranger`, or `malformed` for two bytes), `gas` and `fees` overrides, `funded` whether
 * the chain setup pays its sender. `steps` are the calls in order: `estimate`, `send` and `wait` (a receipt read until
 * it is there or the target's wait ends), each on one operation.
 */
/** @type {any[]} */
export const CASES = [
  {
    id: 'plain-op',
    note: 'deploys its account and sends 1 wei',
    ops: { main: { salt: 1 } },
    steps: [
      ['estimate', 'main'],
      ['send', 'main'],
      ['wait', 'main'],
    ],
    expect: [spec(0, 'estimate.fields', 'complete', REF.estimate), ...lands(1, 2)],
  },
  {
    id: 'batch-calls',
    note: 'one operation with two calls (executeBatch), as sendCalls builds it',
    ops: {
      main: {
        salt: 2,
        calls: [
          { to: RECIPIENT, value: 1n },
          { to: RECIPIENT, value: 2n },
        ],
      },
    },
    steps: [
      ['send', 'main'],
      ['wait', 'main'],
    ],
    expect: lands(0, 1),
  },
  {
    id: 'two-senders',
    note: 'two operations sent back to back, which a bundler may put in one bundle (hashspan#431)',
    ops: { first: { salt: 3 }, second: { salt: 4 } },
    steps: [
      ['send', 'first'],
      ['send', 'second'],
      ['wait', 'first'],
      ['wait', 'second'],
    ],
    expect: [...lands(0, 2), ...lands(1, 3), unspecified(undefined, 'effect.sameBundle')],
  },
  {
    id: 'execution-revert',
    note: 'validation passes, the call reverts with Error("boom")',
    ops: { main: { salt: 5, calls: [{ to: REVERTER, value: 0n }] } },
    steps: [
      ['send', 'main'],
      ['wait', 'main'],
    ],
    expect: [
      unspecified(0, 'accepted'),
      unspecified(1, 'included'),
      spec(1, 'receipt.success', false, REF.receiptSuccess, { when: 'included' }),
      spec(1, 'receipt.reason', 'Error(boom)', REF.receiptReason, { when: 'included' }),
      spec(1, 'receipt.matchesChain', true, REF.receipt, { when: 'included' }),
    ],
  },
  {
    id: 'bad-signature',
    note: 'signed by another key: the account returns SIG_VALIDATION_FAILED',
    ops: { main: { salt: 6, signer: 'stranger' } },
    steps: [['send', 'main']],
    expect: rejected(0, { code: -32507, codeRef: REF.signature }),
  },
  {
    id: 'validation-revert',
    note: 'a two-byte signature: the account reverts in ECDSA.recover, AA23',
    ops: { main: { salt: 7, signer: 'malformed' } },
    steps: [['send', 'main']],
    expect: rejected(0, { code: -32500, codeRef: REF.simulateValidation, aa: 'AA23' }),
  },
  {
    id: 'insufficient-prefund',
    note: 'the sender has no funds and there is no paymaster, AA21',
    ops: { main: { salt: 8, funded: false } },
    steps: [['send', 'main']],
    expect: rejected(0, { code: -32500, codeRef: REF.simulateValidation, aa: 'AA21' }),
  },
  {
    id: 'low-verification-gas',
    note:
      'a verification gas limit too low to deploy the account; ERC-7769 names -32602 for invalid ' +
      'fields and -32500 for a failed simulateValidation, not which applies',
    ops: { main: { salt: 9, gas: { verificationGasLimit: LOW_VERIFICATION_GAS } } },
    steps: [['send', 'main']],
    expect: rejected(0),
  },
  {
    id: 'nonce-reuse',
    note: 'a second operation with the nonce the first one used, AA25',
    ops: {
      first: { salt: 10 },
      reuse: { salt: 10, nonce: 0n, deploy: false, calls: [{ to: RECIPIENT, value: 3n }] },
    },
    steps: [
      ['send', 'first'],
      ['wait', 'first'],
      ['send', 'reuse'],
    ],
    expect: [
      spec(0, 'accepted', true, REF.accepted),
      spec(1, 'included', true, REF.receipt),
      ...rejected(2, { code: -32500, codeRef: REF.simulateValidation, aa: 'AA25' }),
    ],
  },
  {
    id: 'nonce-gap',
    note: 'nonce 1 on an account that has not used 0; a bundler may queue it rather than reject it',
    ops: { main: { salt: 11, nonce: 1n, deploy: true } },
    steps: [['send', 'main']],
    expect: [unspecified(0, 'accepted'), unspecified(0, 'code'), unspecified(0, 'aa')],
  },
  {
    id: 'replacement',
    note: 'the same sender and nonce again with 50 percent higher fees, sent right after the first',
    ops: {
      first: { salt: 12 },
      replacement: { salt: 12, fees: REPLACEMENT_FEES, calls: [{ to: RECIPIENT, value: 4n }] },
    },
    steps: [
      ['send', 'first'],
      ['send', 'replacement'],
      ['wait', 'replacement'],
      ['wait', 'first'],
    ],
    expect: [
      unspecified(0, 'accepted'),
      unspecified(1, 'accepted'),
      unspecified(1, 'code'),
      unspecified(undefined, 'effect.landed'),
    ],
  },
  {
    id: 'pre-verification-gas-out-of-range',
    note: 'a preVerificationGas of 2^128, reported in rundler#1354 to panic the RPC handler of Rundler 0.11.0',
    ops: { main: { salt: 13, gas: { preVerificationGas: HUGE_PRE_VERIFICATION_GAS } } },
    steps: [['send', 'main']],
    expect: [
      spec(0, 'answer', 'error', REF.failure, { known: 'rundler#1354' }),
      spec(0, 'accepted', false, REF.failure),
      unspecified(0, 'code'),
    ],
  },
];

/** The ops of every case, flattened, for the sender table and the chain setup. */
/** @returns {number[]} */
export const saltsOf = (cases = CASES) => [
  ...new Set(cases.flatMap((c) => Object.values(c.ops).map((op) => op.salt))),
];

/** The salts whose senders the chain setup funds. */
/** @returns {number[]} */
export const fundedSalts = (cases = CASES) => [
  ...new Set(
    cases.flatMap((c) =>
      Object.values(c.ops)
        .filter((op) => op.funded !== false)
        .map((op) => op.salt),
    ),
  ),
];

/**
 * A client permissionless can build and sign with offline: the chain id is known, and every account reads as not yet
 * deployed (viem asks before it hands out the factory arguments; buildOp decides itself whether an operation carries
 * them). Nothing else reads the chain.
 */
const offlineClient = {
  chain: { id: CHAIN_ID },
  request: async ({ method }) => {
    if (method === 'eth_getCode') return '0x';
    throw new Error(`the corpus is built offline; ${method} was not expected`);
  },
};

/** The SimpleAccount of `key` with `salt`, at `sender`, as permissionless builds it for EntryPoint v0.7. */
function account(key, salt, sender) {
  return toSimpleSmartAccount({
    client: offlineClient,
    owner: privateKeyToAccount(key),
    factoryAddress: FACTORY,
    entryPoint: { address: ENTRY_POINTS['0.7'], version: '0.7' },
    index: BigInt(salt),
    address: sender,
  });
}

/**
 * One operation of a case, built and signed: its JSON-RPC form and its hash. `senderOf(salt)` gives the sender (the
 * committed table, or the factory on a chain).
 */
export async function buildOp(op, senderOf, fees = FEES) {
  const sender = getAddress(await senderOf(op.salt));
  const owner = await account(ACCOUNTS.owner, op.salt, sender);
  const nonce = op.nonce ?? 0n;
  const deploy = op.deploy ?? nonce === 0n;
  const factoryArgs = deploy ? await owner.getFactoryArgs() : {};
  const userOperation = {
    sender,
    nonce,
    ...factoryArgs,
    callData: await owner.encodeCalls(op.calls ?? [{ to: RECIPIENT, value: 1n }]),
    ...GAS,
    ...op.gas,
    ...fees,
    ...op.fees,
    signature: '0x',
  };
  let signature;
  if (op.signer === 'malformed') signature = '0x1234';
  else {
    const signer =
      op.signer === 'stranger' ? await account(ACCOUNTS.stranger, op.salt, sender) : owner;
    signature = await signer.signUserOperation({ ...userOperation, chainId: CHAIN_ID });
  }
  const signed = { ...userOperation, signature };
  const hash = getUserOperationHash({
    chainId: CHAIN_ID,
    entryPointAddress: ENTRY_POINTS['0.7'],
    entryPointVersion: '0.7',
    userOperation: signed,
  });
  return { hash, userOperation: formatUserOperationRequest(signed) };
}

/**
 * One case, built: its operations by name, its steps and expectations. `saltOffset` moves every account to a salt of
 * its own, for the fault pass; `fees` replaces FEES as the base fees of its operations (feesFor(), in the fault pass).
 * @param {any} c
 * @param {{ senderOf?: (salt: number) => string | undefined | Promise<string | undefined>,
 *   saltOffset?: number, fees?: { maxFeePerGas: bigint, maxPriorityFeePerGas: bigint } }} [options]
 */
export async function buildCase(
  c,
  { senderOf = (salt) => SENDERS[salt], saltOffset = 0, fees = FEES } = {},
) {
  /** @type {Record<string, { hash: string, userOperation: Record<string, string> }>} */
  const ops = {};
  for (const [name, op] of Object.entries(c.ops)) {
    ops[name] = await buildOp({ ...op, salt: op.salt + saltOffset }, senderOf, fees);
  }
  return {
    id: c.id,
    entryPoint: '0.7',
    ...(c.note ? { note: c.note } : {}),
    steps: c.steps.map(([call, op]) => ({ call, op })),
    ops,
    expect: c.expect,
  };
}

/** The committed corpus. */
export async function buildCorpus() {
  const cases = [];
  for (const c of CASES) cases.push(await buildCase(c));
  return {
    id: CORPUS_ID,
    chainId: CHAIN_ID,
    entryPoint: ENTRY_POINTS['0.7'],
    factory: FACTORY,
    ercsCommit: ERCS_COMMIT,
    cases,
  };
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
