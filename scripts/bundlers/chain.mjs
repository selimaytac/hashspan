// Sets a fresh Anvil up for the bundler matrix, as experiment E1 did: the canonical EntryPoint v0.7 and
// SimpleAccountFactory v0.7 deployed through the deterministic deployer from the @account-abstraction/contracts 0.7.0
// artifacts that scripts/install-bundler.sh puts into .tools/bundler (GPL-3.0, so outside the pnpm workspace), the
// reverter at REVERTER, and the senders of the corpus funded. It also reads what the chain says about an operation:
// its UserOperationEvent, the bundle transaction and its receipt, from Anvil directly, never through the proxy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  getAbiItem,
  getContractAddress,
  http,
  parseAbi,
  toEventSelector,
  zeroHash,
} from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { reverterCode } from '../../packages/viem/test/entry-point/test-entry-point.ts';
import {
  ACCOUNTS,
  addressOf,
  CHAIN_ID,
  DEPLOYER,
  ENTRY_POINT_SALT,
  ENTRY_POINTS,
  FACTORY,
  FUNDS,
  feesFor,
  REVERTER,
} from './corpus.mjs';

/** Where scripts/install-bundler.sh installs the EntryPoint v0.7 artifacts, relative to the repository root. */
export const ARTIFACTS_DIR = '.tools/bundler/node_modules/@account-abstraction/contracts/artifacts';

export const factoryAbi = parseAbi([
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
]);

/** The matrix chain at an RPC URL. */
export const chainOf = (rpcUrl) => ({
  id: CHAIN_ID,
  name: 'Anvil (bundler matrix)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const clients = (rpcUrl) => {
  const chain = chainOf(rpcUrl);
  const transport = http(rpcUrl);
  return {
    reader: createPublicClient({ chain, transport, pollingInterval: 100 }),
    node: createTestClient({ chain, mode: 'anvil', transport }),
    wallet: createWalletClient({ chain, transport, pollingInterval: 100 }),
  };
};

/** The creation code of an artifact. */
export const creationCode = (artifactsDir, name) =>
  JSON.parse(readFileSync(join(artifactsDir, `${name}.json`), 'utf8')).bytecode;

/** Deploys `initCode` with `salt` through the deterministic deployer, from the unlocked deployer; returns where. */
async function deploy(rpcUrl, initCode, salt) {
  const { reader, wallet } = clients(rpcUrl);
  const address = getContractAddress({
    opcode: 'CREATE2',
    from: DEPLOYER,
    salt,
    bytecode: initCode,
  });
  const hash = await wallet.sendTransaction({
    account: addressOf(ACCOUNTS.deployer),
    to: DEPLOYER,
    data: concat([salt, initCode]),
  });
  await reader.waitForTransactionReceipt({ hash });
  if ((await reader.getCode({ address })) === undefined) throw new Error(`no code at ${address}`);
  return address;
}

/** The sender of the owner's SimpleAccount with `salt`, from the factory. */
export async function senderOnChain(rpcUrl, salt) {
  return clients(rpcUrl).reader.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: 'getAddress',
    args: [addressOf(ACCOUNTS.owner), BigInt(salt)],
  });
}

/** The fees an operation signed now pays (feesFor()), from the latest base fee and the node's priority fee suggestion. */
export async function chainFees(rpcUrl) {
  const { reader } = clients(rpcUrl);
  const [block, suggestedPriority] = await Promise.all([
    reader.getBlock({ blockTag: 'latest' }),
    reader.request({ method: 'eth_maxPriorityFeePerGas' }).then(BigInt),
  ]);
  return feesFor({ baseFee: block.baseFeePerGas ?? 0n, suggestedPriority });
}

/** Gives `address` `value` (FUNDS unless given), by the node's balance setter. */
export async function fund(rpcUrl, address, value = FUNDS) {
  await clients(rpcUrl).node.setBalance({ address, value });
}

/**
 * Deploys the EntryPoint and the factory on a fresh Anvil, installs the reverter and funds the senders of
 * `fundedSalts`. Throws when an address differs from the one the corpus was built for.
 * @param {string} rpcUrl
 * @param {{ artifactsDir: string, fundedSalts?: number[] }} options
 */
export async function setupChain(rpcUrl, { artifactsDir, fundedSalts = [] }) {
  const { node } = clients(rpcUrl);
  const entryPoint = await deploy(
    rpcUrl,
    creationCode(artifactsDir, 'EntryPoint'),
    ENTRY_POINT_SALT,
  );
  if (entryPoint.toLowerCase() !== ENTRY_POINTS['0.7'].toLowerCase()) {
    throw new Error(`EntryPoint v0.7 at ${entryPoint}, not at the canonical address`);
  }
  const factory = await deploy(
    rpcUrl,
    concat([
      creationCode(artifactsDir, 'SimpleAccountFactory'),
      encodeAbiParameters([{ type: 'address' }], [entryPoint]),
    ]),
    zeroHash,
  );
  if (factory.toLowerCase() !== FACTORY.toLowerCase()) {
    throw new Error(`SimpleAccountFactory at ${factory}, not where the corpus was built for`);
  }
  await node.setCode({ address: REVERTER, bytecode: reverterCode });
  for (const salt of fundedSalts) await fund(rpcUrl, await senderOnChain(rpcUrl, salt));
  return { entryPoint, factory };
}

/** Whether a contract is at each address. */
export async function hasCode(rpcUrl, addresses) {
  const { reader } = clients(rpcUrl);
  const out = {};
  for (const address of addresses) out[address] = Boolean(await reader.getCode({ address }));
  return out;
}

const USER_OPERATION_EVENT = getAbiItem({ abi: entryPoint07Abi, name: 'UserOperationEvent' });
export const USER_OPERATION_EVENT_TOPIC = toEventSelector(USER_OPERATION_EVENT);

/**
 * What the chain shows for an operation hash: every UserOperationEvent of EntryPoint v0.7 with it (a second one would
 * be a double inclusion), with its transaction, block and values, and the bundle's receipt logs count.
 */
export async function chainOperation(rpcUrl, userOpHash) {
  const { reader } = clients(rpcUrl);
  const logs = await reader.getLogs({
    address: ENTRY_POINTS['0.7'],
    event: USER_OPERATION_EVENT,
    args: { userOpHash },
    fromBlock: 0n,
    toBlock: 'latest',
  });
  const events = [];
  for (const log of logs) {
    const receipt = await reader.getTransactionReceipt({ hash: log.transactionHash });
    events.push({
      transactionHash: log.transactionHash,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      sender: log.args.sender,
      paymaster: log.args.paymaster,
      nonce: log.args.nonce,
      success: log.args.success,
      actualGasCost: log.args.actualGasCost,
      actualGasUsed: log.args.actualGasUsed,
      bundleStatus: receipt.status,
      bundleLogs: receipt.logs.length,
    });
  }
  return events;
}

/**
 * A revert reason as the matrix compares it: `Error(<text>)` for a decoded Error(string), `empty`, or the selector of
 * anything else. Never the bytes themselves.
 */
export function reasonOf(reason) {
  if (reason === undefined || reason === null) return 'absent';
  if (typeof reason !== 'string' || !/^0x[0-9a-fA-F]*$/.test(reason)) return 'not-hex';
  if (reason === '0x') return 'empty';
  try {
    const { errorName, args } = decodeErrorResult({ abi: [], data: reason });
    if (errorName === 'Error') return `Error(${String(args?.[0]).slice(0, 60)})`;
    return errorName;
  } catch {
    return `selector ${reason.slice(0, 10)}`;
  }
}
