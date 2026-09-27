import { createTxTracker } from '@hashspan/core';
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
  parseGwei,
  publicActions,
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

  it('keeps the sender out of a failed send span in off mode', async () => {
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      withHashspan({ address: 'off', errorMessages: 'sanitized' }),
    );
    const error = await wallet
      .sendTransaction({ to: RECIPIENT, value: 10n ** 30n })
      .catch((e: unknown) => e);

    expect((error as Error).message.toLowerCase()).toContain(account.slice(2).toLowerCase());
    const send = tracing.spanNamed('send 31337');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    const exported = JSON.stringify({ a: send.attributes, e: send.events, s: send.status });
    expect(exported.toLowerCase()).not.toContain(account.slice(2).toLowerCase());
    expect(exported.toLowerCase()).not.toContain(RECIPIENT.slice(2).toLowerCase());
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

  it("still resolves the caller's wait on the sending client after the background confirmation timed out", async () => {
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    })
      .extend(publicActions)
      .extend(withHashspan({ confirm: { mode: 'background', timeoutMs: 200 } }));
    const rpc = (method: string, params: unknown[] = []) =>
      wallet.request({ method: method as never, params: params as never });

    await rpc('evm_setAutomine', [false]);
    try {
      const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
      const wait = wallet.waitForTransactionReceipt({ hash, timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rpc('evm_mine');
      await expect(wait).resolves.toMatchObject({ transactionHash: hash, status: 'success' });
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
  });

  it('records one confirm span when two extensions share a tracker', async () => {
    const tracker = createTxTracker();
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(withHashspan({ tracker, confirm: { mode: 'background', timeoutMs: 5_000 } }));
    const reader = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(withHashspan({ tracker }));

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    await reader.waitForTransactionReceipt({ hash });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const confirms = tracing.spans().filter((s) => s.name === 'confirm 31337');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.attributes['blockchain.tx.status']).toBe('success');
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

describe('replaced transactions on Anvil', () => {
  const LOW_FEE = { maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') };
  const HIGH_FEE = { maxFeePerGas: parseGwei('20'), maxPriorityFeePerGas: parseGwei('10') };
  const reader = () =>
    createPublicClient({ chain: anvil, transport: http(RPC_URL), pollingInterval: 50 });
  const rpc = (method: string, params: unknown[] = []) =>
    reader().request({ method: method as never, params: params as never });
  const pendingNonce = () =>
    reader().getTransactionCount({ address: account, blockTag: 'pending' });
  const confirmOf = (hash: string) =>
    tracing
      .spans()
      .filter((s) => s.name === 'confirm 31337' && s.attributes['blockchain.tx.hash'] === hash);

  /** Runs `fn` with automine off, so transactions stay pending until `evm_mine`. */
  const withoutAutomine = async (fn: () => Promise<void>): Promise<void> => {
    await rpc('evm_setAutomine', [false]);
    try {
      await fn();
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
  };

  it('attributes the receipt of a sped-up transaction to the replacing hash', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const client = reader().extend(hashspan);

    await withoutAutomine(async () => {
      const nonce = await pendingNonce();
      const original = await wallet.sendTransaction({
        to: RECIPIENT,
        value: 1n,
        nonce,
        ...LOW_FEE,
      });
      const wait = client.waitForTransactionReceipt({ hash: original });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const replacing = await wallet.sendTransaction({
        to: RECIPIENT,
        value: 1n,
        nonce,
        ...HIGH_FEE,
      });
      await rpc('evm_mine');

      const receipt = await wait;
      expect(receipt.transactionHash).toBe(replacing);
      await vi.waitFor(() => expect(confirmOf(replacing)).toHaveLength(1));
      const [originalConfirm] = confirmOf(original);
      const [minedConfirm] = confirmOf(replacing);
      expect(originalConfirm?.attributes).toMatchObject({
        'blockchain.tx.status': 'replaced',
        'blockchain.tx.replacement.hash': replacing,
        'blockchain.tx.replacement.reason': 'repriced',
      });
      expect(originalConfirm?.attributes['blockchain.tx.fee']).toBeUndefined();
      expect(minedConfirm?.attributes).toMatchObject({
        'blockchain.tx.status': 'success',
        'blockchain.tx.fee': (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      });
      expect(minedConfirm?.links.map((l) => l.context.spanId)).toContain(
        originalConfirm?.spanContext().spanId,
      );

      // The mined transaction already has its receipt: a later wait adds no span.
      await client.waitForTransactionReceipt({ hash: replacing });
      expect(confirmOf(replacing)).toHaveLength(1);
    });
  });

  it('records a cancellation found by background confirmation once', async () => {
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(withHashspan({ confirm: { mode: 'background', timeoutMs: 10_000 } }));

    await withoutAutomine(async () => {
      const nonce = await pendingNonce();
      const original = await wallet.sendTransaction({
        to: RECIPIENT,
        value: 1n,
        nonce,
        ...LOW_FEE,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const cancel = await wallet.sendTransaction({ to: account, value: 0n, nonce, ...HIGH_FEE });
      await rpc('evm_mine');

      await vi.waitFor(
        () => {
          expect(confirmOf(original)[0]?.attributes['blockchain.tx.status']).toBe('replaced');
          expect(confirmOf(cancel)[0]?.attributes['blockchain.tx.status']).toBe('success');
        },
        { timeout: 10_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(confirmOf(original)[0]?.attributes['blockchain.tx.replacement.reason']).toBe(
        'cancelled',
      );
      expect(confirmOf(cancel)).toHaveLength(1);
    });
  });

  it('decodes the revert reason of a replacing call to the same contract with the original ABI', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    const client = reader().extend(hashspan);

    await withoutAutomine(async () => {
      const nonce = await pendingNonce();
      const original = await wallet.writeContract({
        address: REVERT_WITH_CUSTOM_ERROR,
        abi: vault,
        functionName: 'withdraw',
        args: [2n],
        gas: 100_000n,
        nonce,
        ...LOW_FEE,
      });
      const wait = client.waitForTransactionReceipt({ hash: original });
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Same contract, different call data: viem reports `replaced`.
      const replacing = await wallet.sendTransaction({
        to: REVERT_WITH_CUSTOM_ERROR,
        data: '0x12345678',
        gas: 100_000n,
        nonce,
        ...HIGH_FEE,
      });
      await rpc('evm_mine');

      expect((await wait).status).toBe('reverted');
      await vi.waitFor(() => expect(confirmOf(replacing)).toHaveLength(1));
      expect(confirmOf(original)[0]?.attributes['blockchain.tx.replacement.reason']).toBe(
        'replaced',
      );
      expect(confirmOf(replacing)[0]?.attributes).toMatchObject({
        'blockchain.tx.status': 'reverted',
        'blockchain.tx.revert.reason': 'InsufficientBalance(1, 2)',
      });
    });
  });
});
