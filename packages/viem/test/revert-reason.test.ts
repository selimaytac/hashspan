import { createPublicClient, createWalletClient, encodeErrorResult, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { FROM, HASH, mockTransport, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

const customErrors = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'error InsufficientBalance(uint256 available, uint256 required)',
]);
const errorString = (message: string) =>
  encodeErrorResult({
    abi: parseAbi(['error Error(string)']),
    errorName: 'Error',
    args: [message],
  });
const insufficient = encodeErrorResult({
  abi: customErrors,
  errorName: 'InsufficientBalance',
  args: [1n, 2n],
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const reverted = (callRevertData: string | undefined) =>
  mockTransport({ receipt: { status: '0x0' }, ...(callRevertData ? { callRevertData } : {}) });

const confirmReason = async () => {
  await vi.waitFor(() => expect(tracing.spans().some((s) => s.name === 'confirm 8453')).toBe(true));
  return tracing.spanNamed('confirm 8453').attributes['blockchain.tx.revert.reason'];
};

describe('revert reason of a contract created in the same block', () => {
  const replayOn = (blocks: string[]) => {
    const { transport, requests } = mockTransport({
      receipt: { status: '0x0' },
      callRevertData: errorString('boom'),
      callRevertsOn: (tag) => blocks.includes(String(tag)),
    });
    const reader = createPublicClient({ chain: base, transport }).extend(withHashspan());
    const calls = () =>
      requests.filter((r) => r.method === 'eth_call').map((r) => (r.params as unknown[])[1]);
    return { reader, calls };
  };

  it('replays on the block itself when the previous block does not revert', async () => {
    // The receipt is in block 0x7b; on 0x7a the contract does not exist yet, so the call succeeds.
    const { reader, calls } = replayOn(['0x7b']);
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBe('boom');
    expect(calls()).toEqual(['0x7a', '0x7b']);
  });

  it('replays once when the previous block reverts', async () => {
    const { reader, calls } = replayOn(['0x7a', '0x7b']);
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBe('boom');
    expect(calls()).toEqual(['0x7a']);
  });

  it('records no reason when neither replay reverts', async () => {
    const { reader, calls } = replayOn([]);
    await reader.waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() =>
      expect(tracing.spans().some((s) => s.name === 'confirm 8453')).toBe(true),
    );
    expect(await confirmReason()).toBeUndefined();
    expect(calls()).toEqual(['0x7a', '0x7b']);
  });
});

describe('revert reason', () => {
  it('decodes Error(string) without an ABI', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: reverted(errorString('boom')).transport,
    }).extend(withHashspan());
    const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
    expect(receipt.status).toBe('reverted');
    expect(await confirmReason()).toBe('boom');
  });

  it('drops a hex value cut by the length bound whole, so no part of an address is recorded', async () => {
    const message = `${'a'.repeat(1000)} ${FROM}`;
    const reader = createPublicClient({
      chain: base,
      transport: reverted(errorString(message)).transport,
    }).extend(withHashspan({ address: 'off' }));
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBe(`${'a'.repeat(1000)} ...`);
  });

  it('decodes custom errors with the ABI used by writeContract', async () => {
    const { transport } = reverted(insufficient);
    const hashspan = withHashspan();
    const wallet = createWalletClient({ account: FROM, chain: base, transport }).extend(hashspan);
    const reader = createPublicClient({ chain: base, transport }).extend(hashspan);

    const hash = await wallet.writeContract({
      address: TO,
      abi: customErrors,
      functionName: 'transfer',
      args: [FROM, 5n],
    });
    await reader.waitForTransactionReceipt({ hash });
    expect(await confirmReason()).toBe('InsufficientBalance(1, 2)');
  });

  it('falls back to the error selector when the ABI is unknown', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: reverted(insufficient).transport,
    }).extend(withHashspan());
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBe(insufficient.slice(0, 10));
  });

  it('records no reason when the replay does not revert', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: reverted(undefined).transport,
    }).extend(withHashspan());
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBeUndefined();
  });

  it('can be turned off, avoiding the extra requests', async () => {
    const { transport, calls } = reverted(errorString('boom'));
    const reader = createPublicClient({ chain: base, transport }).extend(
      withHashspan({ decodeRevertReason: false }),
    );
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBeUndefined();
    expect(calls).not.toContain('eth_call');
  });

  it('makes no extra requests for successful transactions', async () => {
    const { transport, calls } = mockTransport();
    const reader = createPublicClient({ chain: base, transport }).extend(withHashspan());
    await reader.waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(1));
    expect(calls).not.toContain('eth_call');
    expect(calls).not.toContain('eth_getTransactionByHash');
  });
});

describe('revert reason replay timeout', () => {
  it('ends the confirm span without a reason when the provider does not answer the replay', async () => {
    const { transport } = mockTransport({
      receipt: { status: '0x0' },
      hangOn: ['eth_getTransactionByHash'],
    });
    const reader = createPublicClient({ chain: base, transport }).extend(
      withHashspan({ decodeRevertReason: { timeoutMs: 50 } }),
    );

    await reader.waitForTransactionReceipt({ hash: HASH });
    await vi.waitFor(() => expect(tracing.spans()).toHaveLength(1), { timeout: 1_000 });
    const [confirm] = tracing.spans();
    expect(confirm?.attributes['blockchain.tx.status']).toBe('reverted');
    expect(confirm?.attributes['blockchain.tx.revert.reason']).toBeUndefined();
  });

  it('still records the reason when the replay answers in time', async () => {
    const reader = createPublicClient({
      chain: base,
      transport: reverted(errorString('boom')).transport,
    }).extend(withHashspan({ decodeRevertReason: { timeoutMs: 5_000 } }));
    await reader.waitForTransactionReceipt({ hash: HASH });
    expect(await confirmReason()).toBe('boom');
  });
});
