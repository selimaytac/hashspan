import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import { type Address, createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18545;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const REVERTER = '0x00000000000000000000000000000000000000aa' as const;
const TOKEN = '0x00000000000000000000000000000000000000bb' as const;
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
  await instance.start();
  const client = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
  // Runtime bytecode that always reverts: PUSH1 0 PUSH1 0 REVERT.
  await client.request({
    method: 'anvil_setCode' as never,
    params: [REVERTER, '0x60006000fd'] as never,
  });
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
    const confirm = tracing.spanNamed('confirm 31337');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'error.type': 'reverted',
    });
  });
});
