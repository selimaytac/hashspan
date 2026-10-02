import { Instance } from 'prool';
import {
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  getContractAddress,
  type Hex,
  http,
  parseAbi,
} from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18574;
const RPC_URL = `http://127.0.0.1:${PORT}`;
// Anvil's first test account, which Anvil signs for.
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const vault = parseAbi(['error WithdrawalLimitExceeded(uint256 limit, uint256 requested)']);

/** Creation code of a contract whose runtime reverts every call with `payload`. */
function revertingContract(payload: Hex): Hex {
  const bytes = payload.slice(2);
  const size = bytes.length / 2;
  let runtime = '';
  for (let offset = 0; offset < size; offset += 32) {
    const word = bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0');
    runtime += `7f${word}60${offset.toString(16).padStart(2, '0')}52`;
  }
  runtime += `60${size.toString(16).padStart(2, '0')}6000fd`;
  const length = (runtime.length / 2).toString(16).padStart(2, '0');
  return `0x60${length}80600b6000396000f3${runtime}`;
}

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});
beforeAll(async () => {
  await instance.start();
});
afterAll(async () => {
  await instance.stop();
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

it('records the revert reason of a call to a contract created earlier in the same block', async () => {
  const hashspan = withHashspan();
  const reader = createPublicClient({
    chain: anvil,
    transport: http(RPC_URL),
    pollingInterval: 50,
  }).extend(hashspan);
  const wallet = createWalletClient({ account: ACCOUNT, chain: anvil, transport: http(RPC_URL) });
  const payload = encodeErrorResult({
    abi: vault,
    errorName: 'WithdrawalLimitExceeded',
    args: [1n, 2n],
  });

  // Both transactions go into one block, as on a chain whose blocks fill faster than an agent sends.
  await reader.request({ method: 'evm_setAutomine' as never, params: [false] as never });
  const nonce = await reader.getTransactionCount({ address: ACCOUNT });
  const contract = getContractAddress({ from: ACCOUNT, nonce: BigInt(nonce) });
  const deploy = await wallet.sendTransaction({ data: revertingContract(payload), gas: 200_000n });
  // Explicit gas skips estimation, which would fail before the contract exists.
  const call = await wallet.sendTransaction({ to: contract, data: '0x2e1a7d4d', gas: 100_000n });
  await reader.request({ method: 'evm_mine' as never });
  await reader.request({ method: 'evm_setAutomine' as never, params: [true] as never });

  const [created, reverted] = await Promise.all([
    reader.getTransactionReceipt({ hash: deploy }),
    reader.waitForTransactionReceipt({ hash: call }),
  ]);
  expect(created.blockNumber).toBe(reverted.blockNumber);
  expect(reverted.status).toBe('reverted');
  await hashspan.flush();

  // Without the vault's ABI the reason is the error's selector.
  expect(tracing.spanNamed('confirm 31337').attributes['blockchain.tx.revert.reason']).toBe(
    payload.slice(0, 10),
  );
});
