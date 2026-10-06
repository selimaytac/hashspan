import { createTxTracker } from '@hashspan/core';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  encodeFunctionData,
  type Hex,
  http,
  parseAbi,
  parseGwei,
  publicActions,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemAtLeast } from './viem-version.js';

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

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

let tracing: TestTracing;
let account: Address;

beforeAll(async () => {
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

  it('traces a transaction signed elsewhere and broadcast with sendRawTransaction', async () => {
    const { wallet, reader } = clients();
    // Anvil's first account, signing locally from its public test mnemonic: the service's own signer stands in.
    const signer = mnemonicToAccount('test test test test test test test test test test test junk');
    const request = await wallet.prepareTransactionRequest({
      account: signer,
      to: RECIPIENT,
      value: 2_000n,
    });
    const serializedTransaction = await signer.signTransaction(request as never);

    const hash = await wallet.sendRawTransaction({ serializedTransaction });
    await reader.waitForTransactionReceipt({ hash });

    const send = tracing.spanNamed('send 31337');
    const confirm = tracing.spanNamed('confirm 31337');
    expect(send.attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.to': RECIPIENT.toLowerCase(),
      'blockchain.tx.value': '2000',
    });
    expect(send.attributes['blockchain.tx.from']).toBeUndefined();
    expect(confirm.links[0]?.context.spanId).toBe(send.spanContext().spanId);
    expect(confirm.attributes['blockchain.tx.status']).toBe('success');
  });

  it('records a raw send the node rejects and rethrows its error', async () => {
    const { wallet } = clients();
    const signer = mnemonicToAccount('test test test test test test test test test test test junk');
    // Nonce 0 is long used on this chain: the node rejects the transaction.
    const serializedTransaction = await signer.signTransaction({
      chainId: anvil.id,
      to: RECIPIENT,
      value: 1n,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1n,
    });

    await expect(wallet.sendRawTransaction({ serializedTransaction })).rejects.toThrow(/nonce/i);

    const send = tracing.spanNamed('send 31337');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['blockchain.tx.hash']).toBeUndefined();
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

  it('sends the transaction while the send span is active, so HTTP spans of the request nest under it', async () => {
    const active: (string | undefined)[] = [];
    const transport = http(RPC_URL, {
      onFetchRequest: async (request) => {
        const { method } = (await request.clone().json()) as { method: string };
        if (method === 'eth_sendTransaction')
          active.push(trace.getActiveSpan()?.spanContext().spanId);
      },
    });
    const wallet = createWalletClient({ account, chain: anvil, transport }).extend(withHashspan());
    const tool = trace.getTracer('test').startSpan('execute_tool transfer');
    await context.with(trace.setSpan(context.active(), tool), () =>
      wallet.sendTransaction({ to: RECIPIENT, value: 1n }),
    );
    tool.end();

    const send = tracing.spanNamed('send 31337');
    expect(active).toEqual([send.spanContext().spanId]);
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  });

  it('records writeContract arguments when enabled', async () => {
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      withHashspan({ recordFunctionArguments: true }),
    );
    await wallet.writeContract({
      address: TOKEN,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [RECIPIENT, 10n ** 18n],
    });
    expect(
      tracing.spanNamed('send 31337').attributes['blockchain.contract.function.arguments'],
    ).toBe(`["${RECIPIENT}","1000000000000000000"]`);
  });

  it('records arguments without changing the calldata that is mined', async () => {
    const payroll = parseAbi(['function pay((address to, uint256 amount) order)']);
    const order = { to: RECIPIENT as Address, amount: 5n };
    // toJSON() and the getter would change the amount if the instrumentation called them.
    Object.defineProperty(order, 'toJSON', {
      enumerable: false,
      value: () => {
        order.amount = 999n;
        return 'mutated';
      },
    });
    Object.defineProperty(order, 'audit', {
      enumerable: true,
      get: () => {
        order.amount = 777n;
        return 'audited';
      },
    });
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
      withHashspan({ recordFunctionArguments: true }),
    );

    const hash = await wallet.writeContract({
      address: TOKEN,
      abi: payroll,
      functionName: 'pay',
      args: [order],
    });

    const mined = await createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
    }).getTransaction({
      hash,
    });
    expect(mined.input).toBe(
      encodeFunctionData({
        abi: payroll,
        functionName: 'pay',
        args: [{ to: RECIPIENT, amount: 5n }],
      }),
    );
    expect(order.amount).toBe(5n);
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
      // Sequencing, not an assertion: lets the 200 ms background confirmation time out before the block is mined.
      // flush() cannot be used here, as a timed-out flush would also end the caller's own wait.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rpc('evm_mine');
      await expect(wait).resolves.toMatchObject({ transactionHash: hash, status: 'success' });
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
  });

  it('records one confirm span when two extensions share a tracker', async () => {
    const tracker = createTxTracker();
    const sending = withHashspan({ tracker, confirm: { mode: 'background', timeoutMs: 5_000 } });
    const reading = withHashspan({ tracker });
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(sending);
    const reader = createPublicClient({
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(reading);

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    await reader.waitForTransactionReceipt({ hash });
    await Promise.all([sending.flush(), reading.flush()]);

    const confirms = tracing.spans().filter((s) => s.name === 'confirm 31337');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.attributes['blockchain.tx.status']).toBe('success');
  });

  it('watches a transaction sent without the extension', async () => {
    const hashspan = withHashspan();
    // Sent by a client that is not extended, as a wallet API would.
    const plain = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) });
    const hash = await plain.sendTransaction({ to: RECIPIENT, value: 1n });

    hashspan.watch(
      createPublicClient({ chain: anvil, transport: http(RPC_URL), pollingInterval: 50 }),
      {
        hash,
      },
    );
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(tracing.spanNamed('confirm 31337').attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
      'blockchain.tx.gas.used': 21_000,
    });
    expect(tracing.spans().filter((s) => s.name === 'send 31337')).toHaveLength(0);
  });

  it('watches a transaction whose receipt the node returns late', async () => {
    const hashspan = withHashspan();
    const plain = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) });
    const hash = await plain.sendTransaction({ to: RECIPIENT, value: 1n });
    // Anvil mines at once; this transport hides the receipt for the first calls, like a node still indexing it.
    const upstream = http(RPC_URL)({ chain: anvil });
    let hidden = 6;
    const lagging = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_getTransactionReceipt' && hidden > 0) {
          hidden--;
          return null;
        }
        return upstream.request({ method, params } as never);
      },
    });
    const reader = createPublicClient({ chain: anvil, transport: lagging, pollingInterval: 50 });
    // viem alone gives up here before 2.57.3: it finds the transaction itself in the block as a replacement
    // (wevm/viem#5161).
    if (!viemAtLeast('2.57.3')) {
      await expect(reader.waitForTransactionReceipt({ hash, retryDelay: 1 })).rejects.toThrow(
        expect.objectContaining({ name: 'TransactionReceiptNotFoundError' }),
      );
    }

    hidden = 6;
    hashspan.watch(reader, { hash });
    // From viem 2.57.3 the wait reads the receipt again only on a new block, which a chain keeps producing.
    if (viemAtLeast('2.57.3')) {
      await vi.waitFor(
        async () => {
          await upstream.request({ method: 'evm_mine' } as never);
          expect(hidden).toBe(0);
        },
        { timeout: 10_000, interval: 100 },
      );
    }
    await expect(hashspan.flush()).resolves.toBe(true);
    expect(tracing.spanNamed('confirm 31337').attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.status': 'success',
    });
    expect(hidden).toBe(0);
  });

  it('traces clients without a chain once their chain id is known', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account, transport: http(RPC_URL) }).extend(hashspan);
    const reader = createPublicClient({ transport: http(RPC_URL), pollingInterval: 50 }).extend(
      hashspan,
    );

    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n, chain: null });
    await reader.waitForTransactionReceipt({ hash });

    await vi.waitFor(() => {
      expect(tracing.spanNamed('send 31337').attributes['blockchain.tx.hash']).toBe(hash);
      expect(tracing.spanNamed('confirm 31337').attributes['blockchain.tx.status']).toBe('success');
    });
    expect(tracing.spanNamed('confirm 31337').links[0]?.context.spanId).toBe(
      tracing.spanNamed('send 31337').spanContext().spanId,
    );
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

  it('ends every pending span on flush, before a short-lived process shuts down', async () => {
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 5_000 } });
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport: http(RPC_URL),
      pollingInterval: 50,
    }).extend(hashspan);

    await wallet.sendTransaction({ to: REVERT_WITH_MESSAGE, gas: 100_000n });
    await expect(hashspan.flush()).resolves.toBe(true);

    expect(tracing.spanNamed('confirm 31337').attributes).toMatchObject({
      'blockchain.tx.status': 'reverted',
      'blockchain.tx.revert.reason': 'boom',
    });
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
  /**
   * An HTTP transport that reports when viem has fetched a transaction. viem can only detect a replacement once it
   * has seen the original transaction, so tests replace it after that instead of after a fixed delay.
   */
  const watched = () => {
    const seen = new Set<string>();
    const waiters: { hash: string; resolve: () => void }[] = [];
    const transport = http(RPC_URL, {
      onFetchRequest: async (request) => {
        const body: unknown = JSON.parse(await request.clone().text());
        for (const call of Array.isArray(body) ? body : [body]) {
          const { method, params } = call as { method: string; params?: unknown[] };
          if (method !== 'eth_getTransactionByHash') continue;
          const hash = String(params?.[0]).toLowerCase();
          seen.add(hash);
          for (const waiter of waiters.filter((w) => w.hash === hash)) waiter.resolve();
        }
      },
    });
    const fetched = (hash: string): Promise<void> =>
      seen.has(hash.toLowerCase())
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ hash: hash.toLowerCase(), resolve }));
    return { transport, fetched };
  };
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
    const { transport, fetched } = watched();
    const client = createPublicClient({ chain: anvil, transport, pollingInterval: 50 }).extend(
      hashspan,
    );

    await withoutAutomine(async () => {
      const nonce = await pendingNonce();
      const original = await wallet.sendTransaction({
        to: RECIPIENT,
        value: 1n,
        nonce,
        ...LOW_FEE,
      });
      const wait = client.waitForTransactionReceipt({ hash: original });
      await fetched(original);
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
    const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 10_000 } });
    const { transport, fetched } = watched();
    const wallet = createWalletClient({
      account,
      chain: anvil,
      transport,
      pollingInterval: 50,
    }).extend(hashspan);

    await withoutAutomine(async () => {
      const nonce = await pendingNonce();
      const original = await wallet.sendTransaction({
        to: RECIPIENT,
        value: 1n,
        nonce,
        ...LOW_FEE,
      });
      await fetched(original);
      const cancel = await wallet.sendTransaction({ to: account, value: 0n, nonce, ...HIGH_FEE });
      await rpc('evm_mine');

      await vi.waitFor(
        () => {
          expect(confirmOf(original)[0]?.attributes['blockchain.tx.status']).toBe('replaced');
          expect(confirmOf(cancel)[0]?.attributes['blockchain.tx.status']).toBe('success');
        },
        { timeout: 10_000 },
      );
      await hashspan.flush();
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
    const { transport, fetched } = watched();
    const client = createPublicClient({ chain: anvil, transport, pollingInterval: 50 }).extend(
      hashspan,
    );

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
      await fetched(original);
      // Same contract, different call data: viem reports `replaced`; before 2.22.4 it compared no call data and
      // reported `repriced`, which the attribute passes on.
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
        viemAtLeast('2.22.4') ? 'replaced' : 'repriced',
      );
      expect(confirmOf(replacing)[0]?.attributes).toMatchObject({
        'blockchain.tx.status': 'reverted',
        'blockchain.tx.revert.reason': 'InsufficientBalance(1, 2)',
      });
    });
  });
});
