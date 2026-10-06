// sendTransactionSync and writeContractSync against Anvil (#370): an unlocked JSON-RPC account, which viem sends with
// eth_sendTransaction and then waits for, and a local account, which viem sends with eth_sendRawTransactionSync.
import { SpanStatusCode } from '@opentelemetry/api';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  type Hex,
  http,
  parseAbi,
  toHex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast, viemHasAction } from './viem-version.js';

// sendTransactionSync and writeContractSync came with viem 2.38.0.
const SYNC = viemHasAction('sendTransactionSync') && viemHasAction('writeContractSync');

// Anvil's first account: unlocked on the node, and signed for in-process as a local account. The second account is
// the local signer, so the two never compete for a nonce.
const UNLOCKED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const signer = privateKeyToAccount(
  toHex(
    mnemonicToAccount('test test test test test test test test test test test junk', {
      addressIndex: 1,
    }).getHdKey().privateKey as Uint8Array,
  ),
);
const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const BLOCKS = '0x00000000000000000000000000000000000000d2' as const;

const vault = parseAbi(['function withdraw(uint256 amount)', 'error Blocked(address account)']);

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

const anvilInstance = SYNC
  ? await startAnvil({ binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname })
  : undefined;
const RPC_URL = anvilInstance?.rpcUrl ?? '';

let tracing: TestTracing;
beforeAll(async () => {
  if (!anvilInstance) return;
  const client = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
  await client.request({
    method: 'anvil_setCode' as never,
    params: [
      BLOCKS,
      revertingWith(encodeErrorResult({ abi: vault, errorName: 'Blocked', args: [RECIPIENT] })),
    ] as never,
  });
});
afterAll(async () => {
  await anvilInstance?.instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

/** One send span per sync call: viem's internal send and wait are not traced again (`spanNamed` finds the first). */
const expectOneSend = () =>
  expect(tracing.spans().filter((s) => s.name === 'send 31337')).toHaveLength(1);

const accounts = { 'a JSON-RPC account': UNLOCKED as Address, 'a local account': signer };
const gas = 200_000n;

describe.skipIf(!SYNC).each(Object.entries(accounts))('sync actions of %s', (_, account) => {
  const clients = () => {
    const hashspan = withHashspan();
    const make = () =>
      createWalletClient({ account, chain: anvil, transport: http(RPC_URL), pollingInterval: 50 });
    return {
      hashspan,
      traced: make().extend(hashspan),
      reader: createPublicClient({ chain: anvil, transport: http(RPC_URL) }),
    };
  };

  it('records a send span and a confirm span with the receipt sendTransactionSync returns', async () => {
    const { hashspan, traced, reader } = clients();

    const receipt = await traced.sendTransactionSync({ to: RECIPIENT, value: 1n });
    await hashspan.flush();

    // What the caller gets is the node's receipt, as without tracing.
    expect(receipt.status).toBe('success');
    expect(receipt).toEqual(await reader.getTransactionReceipt({ hash: receipt.transactionHash }));
    expectOneSend();
    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(send.attributes['blockchain.tx.hash']).toBe(receipt.transactionHash);
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.hash': receipt.transactionHash,
      'blockchain.tx.status': 'success',
      'blockchain.block.number': Number(receipt.blockNumber),
      'blockchain.tx.fee': (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    });
    // A sync action takes no count (#414).
    expect(confirm.attributes).not.toHaveProperty('blockchain.tx.wait.confirmations');
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
  });

  it('records a reverted writeContractSync with its decoded revert reason', async () => {
    const { hashspan, traced } = clients();

    const receipt = await traced.writeContractSync({
      address: BLOCKS,
      abi: vault,
      functionName: 'withdraw',
      args: [1n],
      gas,
    });
    await hashspan.flush();

    expect(receipt.status).toBe('reverted');
    expectOneSend();
    expect(tracing.spanNamed('send 31337').attributes).toMatchObject({
      'blockchain.tx.hash': receipt.transactionHash,
      'blockchain.contract.function.name': 'withdraw',
    });
    const confirm = tracing.spanNamed('confirm 31337');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['blockchain.tx.status']).toBe('reverted');
    expect(confirm.attributes['blockchain.tx.revert.reason']).toBe(
      `Blocked(${RECIPIENT.toLowerCase()})`,
    );
    expect(confirm.attributes).not.toHaveProperty('blockchain.tx.wait.confirmations');
  });

  // throwOnReceiptRevert came with viem 2.38.2.
  it.skipIf(!viemAtLeast('2.38.2'))(
    'records the reverted receipt of a call that throws on it, and rethrows',
    async () => {
      const { hashspan, traced } = clients();

      const error = await traced
        .sendTransactionSync({ to: BLOCKS, gas, throwOnReceiptRevert: true })
        .catch((e: unknown) => e);
      await hashspan.flush();

      expect(error).toBeInstanceOf(Error);
      expectOneSend();
      expect(tracing.spanNamed('send 31337').status.code).toBe(SpanStatusCode.UNSET);
      expect(tracing.spanNamed('confirm 31337').attributes['blockchain.tx.status']).toBe(
        'reverted',
      );
    },
  );

  it('records a failed send without a confirm span', async () => {
    const { hashspan, traced } = clients();

    // More than the account holds.
    const error = await traced
      .sendTransactionSync({ to: RECIPIENT, value: 10n ** 30n, gas: 21_000n })
      .catch((e: unknown) => e);
    await hashspan.flush();

    expect(error).toBeInstanceOf(Error);
    const send = tracing.spanNamed('send 31337');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 31337']);
  });
});
