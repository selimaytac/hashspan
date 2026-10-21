// What a run reads and does before the flows: the node's genesis parameters, which differ by design between nodes and
// are recorded so a reader sees why a value differs, and for a node that does not prefund the well-known accounts
// (Geth) the funding from its faucet. Setup is recorded, never compared.
import { kindOf, sanitize } from './rpc.mjs';

/** The client name and version of a `web3_clientVersion` answer, without the platform and build parts. */
export function clientOf(version) {
  if (typeof version !== 'string') return 'absent';
  return sanitize(version.split('/').slice(0, 2).join('/'));
}

/**
 * The genesis parameters of a node: chain id, gas limit and base fee of block 0, the kind of its coinbase and
 * timestamp (values that differ by design or name the run's time), the header fields it has, the client name and
 * version, how many accounts it signs for, and the balance of the first well-known account.
 */
export async function genesisOf(rpc, firstAccount) {
  const [chainId, block, version, accounts, balance] = await Promise.all([
    rpc.call('eth_chainId'),
    rpc.call('eth_getBlockByNumber', ['0x0', false]),
    rpc.call('web3_clientVersion'),
    rpc.call('eth_accounts'),
    rpc.call('eth_getBalance', [firstAccount, 'latest']),
  ]);
  const header = block.result ?? {};
  return {
    chainId: chainId.result === undefined ? 'absent' : Number(BigInt(chainId.result)),
    gasLimit: header.gasLimit ?? 'absent',
    baseFeePerGas: header.baseFeePerGas ?? 'absent',
    coinbase: /^0x0{40}$/.test(header.miner ?? '') ? 'zero address' : kindOf(header.miner ?? null),
    timestamp: kindOf(header.timestamp ?? null),
    headerFields: Object.keys(header).sort(),
    client: clientOf(version.result),
    signsFor: Array.isArray(accounts.result) ? accounts.result.length : 0,
    firstAccountBalance: balance.result ?? 'absent',
  };
}

/**
 * Funds each address from the node's first own account (Geth's dev faucet) with `value` wei, one
 * eth_sendTransaction each, and waits for the receipts. Returns the setup record.
 */
export async function fundFromFaucet(rpc, addresses, value) {
  const accounts = await rpc.call('eth_accounts');
  const faucet = accounts.result?.[0];
  if (!faucet) throw new Error('the node signs for no account, so there is no faucet to fund from');
  for (const to of addresses) {
    const sent = await rpc.call('eth_sendTransaction', [
      { from: faucet, to, value: `0x${value.toString(16)}` },
    ]);
    if (sent.error) throw new Error(`funding failed: ${sanitize(sent.error.message)}`);
    const receipt = await rpc.receipt(sent.result);
    if (receipt.result?.status !== '0x1') {
      const why = receipt.error
        ? sanitize(String(receipt.error.message))
        : `status ${receipt.result?.status}`;
      throw new Error(`a funding transaction did not succeed: ${why}`);
    }
  }
  return {
    step: 'fund from faucet',
    accounts: addresses.length,
    value: `${value / 10n ** 18n} ETH`,
  };
}
