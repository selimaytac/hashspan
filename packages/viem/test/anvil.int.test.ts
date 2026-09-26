import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  type Hex,
  http,
  parseAbi,
} from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18545;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const REVERTER = '0x00000000000000000000000000000000000000aa' as const;
const TOKEN = '0x00000000000000000000000000000000000000bb' as const;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const REVERT_WITH_MESSAGE = '0x00000000000000000000000000000000000000a1' as const;
const REVERT_WITH_CUSTOM_ERROR = '0x00000000000000000000000000000000000000a2' as const;

const vault = parseAbi([
  'function withdraw(uint256 amount)',
  'error InsufficientBalance(uint256 available, uint256 required)',
]);

/** Runtime bytecode that stores `payload` in memory and reverts with it. */
function revertingWith(payload: Hex): Hex {
  const bytes = payload.slice(2);
  const size = bytes.length / 2;
  let code = '';
  for (let offset = 0; offset < size; offset += 32) {
    const word = bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0');
    code += `7f${word}60${offset.toString(16).padStart(2, '0')}52`; // PUSH32 word, PUSH1 offset, MSTORE
  }
  return `0x${code}60${size.toString(16).padStart(2, '0')}6000fd`; // PUSH1 size, PUSH1 0, REVERT
}

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  await instance.start();
  const client = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
  const setCode = (address: Address, code: Hex) =>
    client.request({ method: 'anvil_setCode' as never, params: [address, code] as never });
  // Runtime bytecode that always reverts without data: PUSH1 0 PUSH1 0 REVERT.
  await setCode(REVERTER, '0x60006000fd');
  await setCode(
    REVERT_WITH_MESSAGE,
    revertingWith(
      encodeErrorResult({
        abi: parseAbi(['error Error(string)']),
        errorName: 'Error',
        args: ['boom'],
      }),
    ),
  );
  await setCode(
    REVERT_WITH_CUSTOM_ERROR,
    revertingWith(
      encodeErrorResult({ abi: vault, errorName: 'InsufficientBalance', args: [1n, 2n] }),
    ),
  );
  [account] = (await createWalletClient({
    chain: anvil,
    transport: http(RPC_URL),
  }).getAddresses()) as [Address];
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const clients = () => {
  const hashspan = withHashspan();
  return {
    wallet: createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    ),
    reader: createPublicClient({ chain: anvil, transport: http(RPC_URL) }).extend(hashspan),
  };
};

describe('on Anvil', () => {
  it('traces a value transfer from send to confirmation', async () => {
    const { wallet, reader } = clients();
    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1_000n });
    const receipt = await reader.waitForTransactionReceipt({ hash });

    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(send.attributes['blockchain.tx.hash']).toBe(hash);
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
      'blockchain.block.number': Number(receipt.blockNumber),
      'blockchain.tx.fee': (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    });
  });

  it('records the function called by writeContract', async () => {
    const { wallet } = clients();
    await wallet.writeContract({
      address: TOKEN,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [RECIPIENT, 1n],
    });
    expect(tracing.spanNamed('send 31337').attributes).toMatchObject({
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
  });

  it('marks a mined revert as an error on the confirm span', async () => {
    const { wallet, reader } = clients();
    // Explicit gas skips estimation, so the reverting transaction is mined.
    const hash = await wallet.sendTransaction({ to: REVERTER, gas: 50_000n });
    const receipt = await reader.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe('reverted');
    await vi.waitFor(() => expect(tracing.spanNamed('confirm 31337')).toBeDefined());
    const confirm = tracing.spanNamed('confirm 31337');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'error.type': 'reverted',
    });
  });

  it('confirms in the background without an explicit wait', async () => {
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(withHashspan({ confirm: { mode: 'background', timeoutMs: 5_000 } }));

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });

    await vi.waitFor(() => expect(tracing.spanNamed('confirm 31337')).toBeDefined(), {
      timeout: 5_000,
    });
    expect(tracing.spanNamed('confirm 31337').attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
    });
  });

  it('records the revert reason of a mined revert', async () => {
    const { wallet, reader } = clients();
    const hash = await wallet.sendTransaction({ to: REVERT_WITH_MESSAGE, gas: 100_000n });
    await reader.waitForTransactionReceipt({ hash });

    await vi.waitFor(() => expect(tracing.spanNamed('confirm 31337')).toBeDefined());
    expect(tracing.spanNamed('confirm 31337').attributes['blockchain.tx.revert.reason']).toBe(
      'boom',
    );
  });

  it('decodes custom errors with the ABI passed to writeContract', async () => {
    const { wallet, reader } = clients();
    const hash = await wallet.writeContract({
      address: REVERT_WITH_CUSTOM_ERROR,
      abi: vault,
      functionName: 'withdraw',
      args: [2n],
      gas: 100_000n,
    });
    await reader.waitForTransactionReceipt({ hash });

    await vi.waitFor(() => expect(tracing.spanNamed('confirm 31337')).toBeDefined());
    expect(tracing.spanNamed('confirm 31337').attributes['blockchain.tx.revert.reason']).toBe(
      'InsufficientBalance(1, 2)',
    );
  });
});
