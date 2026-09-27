import { createTxTracker, type TxTracker } from '@hashspan/core';
import { context, diag, SpanStatusCode, trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, parseAbi, publicActions } from 'viem';
import { base, mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('sendTransaction', () => {
  it('emits a send span under the active span and returns the hash', async () => {
    const { transport } = mockTransport();
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );
    const tool = trace.getTracer('test').startSpan('execute_tool pay');

    const hash = await context.with(trace.setSpan(context.active(), tool), () =>
      wallet.sendTransaction({ to: TO, value: 5n, data: '0xa9059cbb0000' }),
    );
    tool.end();

    expect(hash).toBe(HASH);
    const send = tracing.spanNamed('send 8453');
    expect(send.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(send.attributes).toMatchObject({
      'blockchain.chain.id': 8453,
      'blockchain.tx.hash': HASH,
      'blockchain.tx.from': FROM,
      'blockchain.tx.to': TO,
      'blockchain.tx.value': '5',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
    expect(send.attributes['blockchain.contract.function.name']).toBeUndefined();
  });

  it('records a failed send and rethrows the original error', async () => {
    const { transport } = mockTransport({
      sendError: { code: -32000, message: 'insufficient funds' },
    });
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );

    const error = await wallet.sendTransaction({ to: TO, value: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const send = tracing.spanNamed('send 8453');
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
    expect(send.attributes['error.type']).toBe((error as Error).name);
  });

  it('keeps addresses and calldata out of failed send spans in off mode', async () => {
    const { transport } = mockTransport({
      sendError: { code: -32000, message: `insufficient funds: address ${FROM} have 0 want 1` },
    });
    for (const errorMessages of [undefined, 'sanitized'] as const) {
      tracing.exporter.reset();
      const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
        withHashspan({ address: 'off', errorMessages }),
      );
      const error = await wallet
        .sendTransaction({ to: TO, data: `0xa9059cbb${'00'.repeat(12)}${TO.slice(2)}` })
        .catch((e: unknown) => e);

      // The caller still gets viem's full error.
      expect((error as Error).message).toContain(FROM);
      const send = tracing.spanNamed('send 8453');
      const exported = JSON.stringify({ a: send.attributes, e: send.events, s: send.status });
      expect(exported.toLowerCase()).not.toContain(FROM.slice(2));
      expect(exported.toLowerCase()).not.toContain(TO.slice(2));
    }
  });

  it('logs only error names through diag', async () => {
    const diagDebug = vi.spyOn(diag, 'debug').mockImplementation(() => {});
    const { transport } = mockTransport({ receipt: { status: '0x0' } });
    const reader = createPublicClient({
      chain: base,
      transport: (opts) => {
        const t = transport(opts);
        return {
          ...t,
          request: (async (args: { method: string }) => {
            if (args.method === 'eth_getTransactionByHash') {
              throw new Error(`lookup failed for ${FROM} at https://rpc.example/secret-key`);
            }
            return t.request(args as never);
          }) as never,
        };
      },
    }).extend(withHashspan());

    await reader.waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() => expect(tracing.spanNamed('confirm 8453')).toBeDefined());
    const args = diagDebug.mock.calls.flat();
    expect(args.every((arg) => typeof arg === 'string')).toBe(true);
    const logged = args.join('\n');
    expect(logged).toContain('could not fetch revert reason');
    expect(logged).not.toContain(FROM);
    expect(logged).not.toContain('secret-key');
  });

  it('resolves the chain id for every call when the client has no chain', async () => {
    const answers = ['0x1', '0xa'];
    const { transport } = mockTransport({ chainId: () => answers.shift() ?? '0xa' });
    const wallet = createWalletClient({ account: FROM, transport }).extend(withHashspan());
    await wallet.sendTransaction({ to: TO, chain: null });
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(1));
    // The wallet switched networks: the next span uses the new chain id, not a cached one.
    await wallet.sendTransaction({ to: TO, chain: null });
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(2));
    expect(tracing.spans().map((s) => s.name)).toEqual(['send 1', 'send 10']);
  });
});

describe('writeContract', () => {
  it('records the function name and selector', async () => {
    const { transport } = mockTransport();
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(
      withHashspan(),
    );
    await wallet.writeContract({
      address: TO,
      abi: erc20,
      functionName: 'transfer',
      args: [FROM, 1n],
    });

    expect(tracing.spans()).toHaveLength(1);
    expect(tracing.spanNamed('send 8453').attributes).toMatchObject({
      'blockchain.tx.to': TO,
      'blockchain.contract.function.name': 'transfer',
      'blockchain.contract.function.selector': '0xa9059cbb',
    });
  });
});

describe('waitForTransactionReceipt', () => {
  it('links the confirm span across a separate public client and records OP-stack fees', async () => {
    const hashspan = withHashspan();
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: { l1Fee: '0x1388' } }).transport,
    }).extend(hashspan);

    const hash = await wallet.sendTransaction({ to: TO });
    const receipt = await reader.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe('success');
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.links[0]?.context.spanId).toBe(
      tracing.spanNamed('send 8453').spanContext().spanId,
    );
    expect(confirm.attributes).toMatchObject({
      'blockchain.tx.status': 'success',
      'blockchain.block.number': 123,
      'blockchain.tx.gas.used': 21_000,
      'blockchain.tx.effective_gas_price': '1000000000',
      'blockchain.tx.l1_fee': '5000',
      'blockchain.tx.fee': '21000000005000',
    });
  });

  it('reads an unformatted hex l1Fee on chains without the OP-stack formatter', async () => {
    const reader = createPublicClient({
      chain: mainnet,
      transport: mockTransport({ chainIdHex: '0x1', receipt: { l1Fee: '0x1388' } }).transport,
    }).extend(withHashspan());
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spanNamed('confirm 1').attributes['blockchain.tx.l1_fee']).toBe('5000');
  });

  it('records reverted receipts as errors', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: { status: '0x0' } }).transport,
    }).extend(withHashspan());
    const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
    expect(receipt.status).toBe('reverted');
    // The confirm span ends after the revert reason was fetched.
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(1));
    const confirm = tracing.spanNamed('confirm 8453');
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['error.type']).toBe('reverted');
  });

  it('records timeouts and rethrows', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: mockTransport({ receipt: null }).transport,
      pollingInterval: 10,
    }).extend(withHashspan());
    const error = await reader
      .waitForTransactionReceipt({ hash: HASH, timeout: 60 })
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe('WaitForTransactionReceiptTimeoutError');
    expect(tracing.spanNamed('confirm 8453').attributes).toMatchObject({
      'blockchain.tx.status': 'timeout',
      'error.type': 'timeout',
    });
  });
});

describe('robustness', () => {
  it('never breaks the call when the tracker throws', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const broken = createTxTracker();
    broken.startSend = () => {
      throw new Error('boom');
    };
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(withHashspan({ tracker: broken }));
    await expect(wallet.sendTransaction({ to: TO })).resolves.toBe(HASH);
  });

  /** A tracker whose every handle method throws, as a buggy user-provided tracker might. */
  const throwingHandles = (): TxTracker => {
    const boom = () => {
      throw new Error('tracker bug');
    };
    return {
      startSend: () => ({ end: boom, fail: boom }),
      startConfirm: () => ({ end: boom, timeout: boom, fail: boom }),
    };
  };

  /** Fails the test on any unhandled rejection raised while `run` executes (and shortly after). */
  const withoutUnhandledRejections = async (run: () => Promise<void>): Promise<void> => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  };

  it('returns the hash when the tracker throws after the transaction was sent', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(withHashspan({ tracker: throwingHandles() }));
    await expect(wallet.sendTransaction({ to: TO })).resolves.toBe(HASH);
  });

  it('rethrows the original send error when the tracker throws while recording it', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const { transport } = mockTransport({ sendError: { code: -32000, message: 'nonce too low' } });
    const plain = createWalletClient({ account: FROM, chain: base, transport });
    const traced = plain.extend(withHashspan({ tracker: throwingHandles() }));

    const expected = await plain.sendTransaction({ to: TO }).catch((e: unknown) => e);
    const actual = await traced.sendTransaction({ to: TO }).catch((e: unknown) => e);
    expect(actual).toBeInstanceOf(Error);
    expect((actual as Error).name).toBe((expected as Error).name);
    expect((actual as Error).message).toBe((expected as Error).message);
  });

  it('returns the receipt when the tracker throws while recording it', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport }).extend(
      withHashspan({ tracker: throwingHandles() }),
    );
    await withoutUnhandledRejections(async () => {
      const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
      expect(receipt.transactionHash).toBe(HASH);
    });
  });

  it('returns the receipt when starting the confirm span throws', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const broken = createTxTracker();
    broken.startConfirm = () => {
      throw new Error('boom');
    };
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport }).extend(
      withHashspan({ tracker: broken }),
    );
    const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
    expect(receipt.transactionHash).toBe(HASH);
  });

  it('raises no unhandled rejection when the tracker throws on a failed or timed-out wait', async () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    await withoutUnhandledRejections(async () => {
      // Timeout of a background confirmation.
      const wallet = createWalletClient({
        account: FROM,
        chain: base,
        transport: mockTransport({ receipt: null }).transport,
        pollingInterval: 10,
      }).extend(
        withHashspan({
          tracker: throwingHandles(),
          confirm: { mode: 'background', timeoutMs: 30 },
        }),
      );
      await wallet.sendTransaction({ to: TO });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Failure of the caller's own wait.
      const { transport } = mockTransport();
      const reader = createPublicClient({
        chain: base,
        transport: (opts) => {
          const t = transport(opts);
          return {
            ...t,
            request: (async (args: { method: string }) => {
              if (args.method === 'eth_getTransactionReceipt') throw new Error('rpc down');
              return t.request(args as never);
            }) as never,
          };
        },
        pollingInterval: 10,
      }).extend(withHashspan({ tracker: throwingHandles() }));
      await expect(
        reader.waitForTransactionReceipt({ hash: HASH, retryCount: 0 }),
      ).rejects.toThrow();
    });
  });

  it('only overrides actions the client has', () => {
    const extension = withHashspan()(
      createPublicClient({ chain: base, transport: mockTransport().transport }),
    );
    expect(Object.keys(extension)).toEqual(['waitForTransactionReceipt']);
  });

  it('is shadowed by publicActions applied afterwards, so it must be applied last', async () => {
    const make = () =>
      createWalletClient({ account: FROM, chain: base, transport: mockTransport().transport });

    await make()
      .extend(withHashspan())
      .extend(publicActions)
      .waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spans()).toHaveLength(0);

    await make()
      .extend(publicActions)
      .extend(withHashspan())
      .waitForTransactionReceipt({ hash: HASH });
    expect(tracing.spans().map((s) => s.name)).toEqual(['confirm 8453']);
  });
});

describe('types', () => {
  it('preserves viem action signatures', () => {
    const wallet = createWalletClient({
      account: FROM,
      chain: base,
      transport: mockTransport().transport,
    }).extend(withHashspan());
    const reader = createPublicClient({ chain: base, transport: mockTransport().transport }).extend(
      withHashspan(),
    );
    expectTypeOf(wallet.sendTransaction).returns.resolves.toEqualTypeOf<`0x${string}`>();
    expectTypeOf(wallet.writeContract).returns.resolves.toEqualTypeOf<`0x${string}`>();
    expectTypeOf(reader.waitForTransactionReceipt).returns.resolves.toHaveProperty('gasUsed');
    expectTypeOf(reader.getBlockNumber).returns.resolves.toEqualTypeOf<bigint>();
  });
});
