// The OP Stack operator fee (issue #287): read with one eth_call to GasPriceOracle.getOperatorFee(gasUsed) at the
// receipt's block, only when the receipt carries operatorFeeScalar or operatorFeeConstant, and recorded as
// blockchain.tx.operator_fee apart from blockchain.tx.fee.
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { createPublicClient, encodeErrorResult, encodeFunctionData, parseAbi, toHex } from 'viem';
import { base, mainnet } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { GAS_PRICE_ORACLE, HASH, type MockOptions, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** The mock receipt: 21 000 gas at 1 gwei, in block 0x7b. */
const FEE = '21000000000000';
const CHARGED = { operatorFeeScalar: '0x3e8', operatorFeeConstant: '0x0' };
const word = (value: bigint) => toHex(value, { size: 32 });
const OPERATOR_FEE = 1_234_567n;

/** The requests among `requests` that call the GasPriceOracle. */
const oracleCallsOf = (requests: { method: string; params?: unknown }[]) =>
  requests.filter(
    (r) =>
      r.method === 'eth_call' &&
      String((r.params as { to?: string }[])[0]?.to).toLowerCase() === GAS_PRICE_ORACLE,
  );

/** Waits for the receipt on a Base reader over a mock node; returns the confirm span's attributes and the requests. */
async function confirm(options: MockOptions, flushTimeoutMs?: number) {
  const node = mockTransport({ retryCount: 0, operatorFee: () => word(OPERATOR_FEE), ...options });
  const hashspan = withHashspan();
  const reader = createPublicClient({ chain: base, transport: node.transport }).extend(hashspan);
  const receipt = await reader.waitForTransactionReceipt({ hash: HASH });
  const flushed = await hashspan.flush(
    flushTimeoutMs === undefined ? undefined : { timeoutMs: flushTimeoutMs },
  );
  const [span] = tracing.spans().filter((s) => s.name === 'confirm 8453');
  const oracleCalls = oracleCallsOf(node.requests);
  return { span, attributes: span?.attributes ?? {}, receipt, flushed, node, oracleCalls };
}

describe('the OP Stack operator fee', () => {
  it('is read with one eth_call at the receipt block and recorded apart from blockchain.tx.fee', async () => {
    const { attributes, oracleCalls, receipt } = await confirm({ receipt: CHARGED });
    expect(attributes['blockchain.tx.operator_fee']).toBe(OPERATOR_FEE.toString());
    expect(attributes['blockchain.tx.fee']).toBe(FEE);
    expect(oracleCalls).toHaveLength(1);
    const [request, block] = (oracleCalls[0]?.params ?? []) as [{ data: string }, string];
    expect(request.data).toBe(
      encodeFunctionData({
        abi: parseAbi(['function getOperatorFee(uint256) view returns (uint256)']),
        functionName: 'getOperatorFee',
        args: [21_000n],
      }),
    );
    expect(block).toBe('0x7b');
    // The caller's receipt is what the node returned, fields included.
    expect((receipt as unknown as Record<string, unknown>).operatorFeeScalar).toBe('0x3e8');
  });

  it('is read when only the constant is set, also on a chain without the OP Stack formatter', async () => {
    const node = mockTransport({
      chainIdHex: '0x1',
      receipt: { operatorFeeConstant: '0x5' },
      operatorFee: () => word(5n),
    });
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: mainnet, transport: node.transport }).extend(
      hashspan,
    );
    await reader.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    expect(tracing.spanNamed('confirm 1').attributes['blockchain.tx.operator_fee']).toBe('5');
  });

  it('costs no request and records nothing for a receipt without the fields', async () => {
    const { attributes, node } = await confirm({});
    expect(node.calls).not.toContain('eth_call');
    expect(attributes).not.toHaveProperty('blockchain.tx.operator_fee');
    expect(attributes['blockchain.tx.fee']).toBe(FEE);
  });

  it.each([
    ['both zero', { operatorFeeScalar: '0x0', operatorFeeConstant: '0x0' }],
    ['not hex', { operatorFeeScalar: 'nope', operatorFeeConstant: '12' }],
    ['longer than 256 bits', { operatorFeeScalar: `0x1${'0'.repeat(64)}` }],
    ['empty hex', { operatorFeeScalar: '0x' }],
    ['numbers', { operatorFeeScalar: 1000, operatorFeeConstant: 5 }],
    ['objects', { operatorFeeScalar: { valueOf: (): number => 1 }, operatorFeeConstant: [1] }],
    ['null', { operatorFeeScalar: null, operatorFeeConstant: null }],
    ['on a deposit transaction', { ...CHARGED, type: '0x7e' }],
  ])('costs no request for fields that are %s', async (_name, fields) => {
    const { attributes, node, span } = await confirm({ receipt: fields });
    expect(node.calls).not.toContain('eth_call');
    expect(attributes).not.toHaveProperty('blockchain.tx.operator_fee');
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records the receipt without it when the call fails, and logs no error', async () => {
    const error = vi.spyOn(diag, 'error');
    const { attributes, oracleCalls, span } = await confirm({
      receipt: CHARGED,
      operatorFee: () => {
        throw new Error('missing trie node');
      },
    });
    expect(oracleCalls).toHaveLength(1);
    expect(attributes).not.toHaveProperty('blockchain.tx.operator_fee');
    expect(attributes['blockchain.tx.fee']).toBe(FEE);
    expect(attributes['blockchain.tx.status']).toBe('success');
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', '0x'],
    ['shorter than a word', '0x01'],
    ['longer than a word', `${word(1n)}00`],
    ['two words', `${word(1n)}${word(2n).slice(2)}`],
    ['not hex', `0x${'zz'.repeat(32)}`],
    ['a number', 5],
    ['null', null],
    ['an object', { data: word(1n) }],
  ])('records nothing for an answer that is %s', async (_name, answer) => {
    const { attributes } = await confirm({ receipt: CHARGED, operatorFee: () => answer });
    expect(attributes).not.toHaveProperty('blockchain.tx.operator_fee');
    expect(attributes['blockchain.tx.fee']).toBe(FEE);
  });

  it('records the largest uint256 in full', async () => {
    const max = 2n ** 256n - 1n;
    const { attributes } = await confirm({ receipt: CHARGED, operatorFee: () => word(max) });
    expect(attributes['blockchain.tx.operator_fee']).toBe(max.toString());
  });

  it('keeps the arrival of the receipt as the end time, not the end of the call', async () => {
    const started = Date.now();
    const { span } = await confirm({
      receipt: CHARGED,
      operatorFee: () =>
        new Promise((resolve) => setTimeout(() => resolve(word(OPERATOR_FEE)), 300)),
    });
    expect(span?.attributes['blockchain.tx.operator_fee']).toBe(OPERATOR_FEE.toString());
    const endMs = span ? span.endTime[0] * 1000 + span.endTime[1] / 1e6 : 0;
    expect(endMs - started).toBeLessThan(250);
  });

  it('records the receipt without it when flush() cannot wait for the call', async () => {
    const { attributes, flushed } = await confirm(
      { receipt: CHARGED, operatorFee: () => new Promise(() => {}) },
      50,
    );
    expect(flushed).toBe(false);
    expect(attributes['blockchain.tx.status']).toBe('success');
    expect(attributes['blockchain.tx.fee']).toBe(FEE);
    expect(attributes).not.toHaveProperty('blockchain.tx.operator_fee');
  });

  it('is read once for concurrent waits for one transaction', async () => {
    const node = mockTransport({ receipt: CHARGED, operatorFee: () => word(OPERATOR_FEE) });
    const hashspan = withHashspan();
    const reader = createPublicClient({ chain: base, transport: node.transport }).extend(hashspan);
    await Promise.all([
      reader.waitForTransactionReceipt({ hash: HASH }),
      reader.waitForTransactionReceipt({ hash: HASH }),
    ]);
    await hashspan.flush();
    const oracle = oracleCallsOf(node.requests);
    expect(oracle).toHaveLength(1);
    const confirms = tracing.spans().filter((s) => s.name === 'confirm 8453');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.attributes['blockchain.tx.operator_fee']).toBe(OPERATOR_FEE.toString());
  });

  it('is recorded with the revert reason of a reverted transaction', async () => {
    const abi = parseAbi(['error Insufficient(uint256 needed)']);
    const { attributes } = await confirm({
      receipt: { ...CHARGED, status: '0x0' },
      callRevertData: encodeErrorResult({ abi, errorName: 'Insufficient', args: [7n] }),
    });
    expect(attributes['blockchain.tx.status']).toBe('reverted');
    expect(attributes['blockchain.tx.revert.reason']).toMatch(/^0x[0-9a-f]{8}$/);
    expect(attributes['blockchain.tx.operator_fee']).toBe(OPERATOR_FEE.toString());
  });

  it('is read for the sealed receipt only, after a preconfirmation (ADR 0024)', async () => {
    const node = mockTransport({
      receipt: CHARGED,
      receiptAt: (call) => (call === 1 ? { blockHash: `0x${'00'.repeat(32)}` } : {}),
      operatorFee: () => word(OPERATOR_FEE),
    });
    const hashspan = withHashspan();
    const reader = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 10,
    }).extend(hashspan);
    await reader.waitForTransactionReceipt({ hash: HASH });
    await hashspan.flush();
    const oracle = oracleCallsOf(node.requests);
    expect(oracle).toHaveLength(1);
    // The call came after the sealed receipt was read.
    const methods = node.requests.map((r) => r.method);
    expect(methods.lastIndexOf('eth_getTransactionReceipt')).toBeLessThan(
      methods.lastIndexOf('eth_call'),
    );
    expect(tracing.spanNamed('confirm 8453').attributes['blockchain.tx.operator_fee']).toBe(
      OPERATOR_FEE.toString(),
    );
  });
});
