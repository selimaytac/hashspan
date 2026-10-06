// A sync send that returns a pending receipt (#402): a Tempo multisig relay answers `eth_sendRawTransactionSync` for an
// approval below quorum with `status: 'pending'` and the multisig operation's hash, and answers receipt lookups of
// that hash with nothing until the transaction is submitted, then with the transaction's receipt, which names the
// operation under `multisig`. The confirm span keeps waiting off the caller's path, within the confirmation timeout
// and the background limit, with a fixed bound on the receipt requests it adds.
import { context, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { createWalletClient, custom, formatTransactionReceipt, publicActions } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PENDING_RECEIPT_REQUESTS } from '../src/confirm/confirmation.js';
import { withHashspan } from '../src/index.js';
import { FROM, TO } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemHasAction } from './viem-version.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

/** The multisig operation's hash, which the pending receipt and the send span carry. */
const OPERATION = `0x${'0e'.repeat(32)}` as const;
/** The hash of the transaction the relay submits once the operation reached quorum. */
const SUBMITTED = `0x${'5b'.repeat(32)}` as const;
const CHAIN_ID = base.id;
const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;

// Anvil's first test account, from its public default mnemonic; the mock node never checks the signature.
const signer = mnemonicToAccount('test test test test test test test test test test test junk');
const PREPARED = { gas: 21_000n, nonce: 0, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as const;

/** The relay's answer to a sync send below quorum (viem's `tempo/internal/relay/multisig.ts`, `pendingResult`). */
const pendingReceipt = () => ({
  blockHash: null,
  blockNumber: null,
  contractAddress: null,
  cumulativeGasUsed: null,
  effectiveGasPrice: null,
  from: FROM,
  gasUsed: null,
  logs: [],
  logsBloom: null,
  multisig: { hash: OPERATION, status: 'pending', type: 'transaction' },
  status: 'pending',
  to: null,
  transactionHash: OPERATION,
  transactionIndex: null,
  type: '0x76',
});

/** The relay's answer to a receipt lookup of the operation once it was submitted. */
const submittedReceipt = (fields: Record<string, unknown> = {}) => ({
  blockHash: `0x${'cd'.repeat(32)}`,
  blockNumber: '0x7b',
  contractAddress: null,
  cumulativeGasUsed: '0x5208',
  effectiveGasPrice: '0x3b9aca00',
  from: FROM,
  gasUsed: '0x5208',
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  multisig: { hash: OPERATION, status: 'success', type: 'transaction' },
  status: '0x1',
  to: TO,
  transactionHash: SUBMITTED,
  transactionIndex: '0x0',
  type: '0x76',
  ...fields,
});

interface RelayOptions {
  /** Answers each `eth_getTransactionReceipt` (the first is 1); null while the operation is pending. */
  receiptAt?: (call: number) => Record<string, unknown> | null;
}

/** A node behind a multisig relay, which records every request. */
function relay({ receiptAt = () => null }: RelayOptions = {}) {
  const calls: string[] = [];
  let receipts = 0;
  let block = 0x7b;
  const transport = custom(
    {
      async request({ method }: { method: string }) {
        calls.push(method);
        switch (method) {
          case 'eth_chainId':
            return CHAIN_ID_HEX;
          case 'eth_sendRawTransactionSync':
            return pendingReceipt();
          case 'eth_getTransactionReceipt':
            return receiptAt(++receipts);
          case 'eth_blockNumber':
            // A new block on every poll, so that a caller's wait asks for the receipt again.
            return `0x${(block++).toString(16)}`;
          case 'eth_getTransactionByHash':
            // The relay answers with the operation's transaction; viem only looks for a replacement with it.
            return null;
          default:
            throw new Error(`mock relay: ${method} not answered`);
        }
      },
    },
    { retryCount: 0 },
  );
  return {
    transport,
    calls,
    receiptCalls: () => calls.filter((m) => m === 'eth_getTransactionReceipt').length,
  };
}

/**
 * A chain whose receipt formatter does what viem's Tempo formatter (`viem/tempo`, `Formatters.ts`) does with a
 * pending receipt: `status: 'pending'` and `type: 'tempo'`. Without it, viem's own formatter gives no status.
 */
const tempoLike = {
  ...base,
  formatters: {
    transactionReceipt: {
      format: (receipt: Record<string, unknown>) => ({
        ...formatTransactionReceipt(receipt as never),
        ...(receipt.status === 'pending' ? { status: 'pending', type: 'tempo' } : {}),
      }),
    },
  },
};

type Chain = typeof base | typeof tempoLike;

function wallets(
  options: RelayOptions = {},
  hashspanOptions: Parameters<typeof withHashspan>[0] = {},
  chain: Chain = tempoLike,
) {
  const hashspan = withHashspan(hashspanOptions);
  const node = relay(options);
  const plainNode = relay(options);
  const make = (transport: ReturnType<typeof custom>) =>
    createWalletClient({
      account: signer,
      chain: chain as typeof base,
      transport,
      pollingInterval: 1,
    }).extend(publicActions);
  return {
    hashspan,
    node,
    plainNode,
    traced: make(node.transport).extend(hashspan),
    plain: make(plainNode.transport),
  };
}

const send = (client: ReturnType<typeof wallets>['traced']) =>
  client.sendTransactionSync({ to: TO, value: 1n, ...PREPARED });

/** A short confirmation timeout, so that the polls, spread over it, come quickly. */
const SHORT = { confirm: { mode: 'background', timeoutMs: 300 } } as const;

const toMs = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);
const confirmSpans = (): ReadableSpan[] =>
  tracing.spans().filter((s) => s.name === `confirm ${CHAIN_ID}`);
const sendSpan = () => tracing.spanNamed(`send ${CHAIN_ID}`);

// sendTransactionSync came with viem 2.38.0.
describe.skipIf(!viemHasAction('sendTransactionSync'))(
  'a sync send that returns a pending receipt',
  () => {
    for (const [form, chain] of [
      ["with viem's Tempo receipt formatter", tempoLike],
      ["with viem's own receipt formatter", base],
    ] as const) {
      it(`keeps waiting for the submitted transaction's receipt off the caller's path, ${form}`, async () => {
        let submitted = false;
        const { hashspan, traced, plain, node } = wallets(
          { receiptAt: () => (submitted ? submittedReceipt() : null) },
          SHORT,
          chain,
        );
        const tool = trace.getTracer('test').startSpan('execute_tool approve');
        const result = await context.with(trace.setSpan(context.active(), tool), () =>
          send(traced),
        );
        tool.end();

        // The caller gets viem's result, as without hashspan, at once.
        expect(result).toEqual(await send(plain));
        // The send span ended when the call returned; the confirm span has not.
        expect(sendSpan().attributes['blockchain.tx.hash']).toBe(OPERATION);
        expect(confirmSpans()).toEqual([]);

        submitted = true;
        await hashspan.flush();

        const [confirm, ...more] = confirmSpans();
        expect(more).toEqual([]);
        expect(confirm?.attributes).toMatchObject({
          'blockchain.tx.hash': OPERATION,
          'blockchain.tx.status': 'success',
          'blockchain.block.number': 123,
          'blockchain.tx.gas.used': 21_000,
        });
        expect(confirm?.attributes).not.toHaveProperty('error.type');
        expect(confirm?.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
        expect(toMs(confirm?.startTime)).toBe(toMs(sendSpan().startTime));
        expect(node.receiptCalls()).toBeGreaterThan(0);
      });
    }

    it('ends the confirm span as `timeout` when the transaction is not submitted within the timeout', async () => {
      const { hashspan, traced, node } = wallets(
        {},
        { confirm: { mode: 'background', timeoutMs: 50 } },
      );
      await send(traced);
      await hashspan.flush();

      const [confirm] = confirmSpans();
      expect(confirm?.attributes['error.type']).toBe('timeout');
      expect(confirm?.attributes).not.toHaveProperty('blockchain.tx.status');
      expect(node.receiptCalls()).toBeGreaterThan(0);
      expect(node.receiptCalls()).toBeLessThanOrEqual(MAX_PENDING_RECEIPT_REQUESTS);
    });

    it('adds at most a fixed number of receipt requests, however short the polling interval', async () => {
      const { hashspan, traced, node, plainNode, plain } = wallets(
        {},
        { confirm: { mode: 'background', timeoutMs: 300 } },
      );
      await send(traced);
      await send(plain);
      await hashspan.flush();

      expect(confirmSpans()[0]?.attributes['error.type']).toBe('timeout');
      expect(node.receiptCalls()).toBeLessThanOrEqual(MAX_PENDING_RECEIPT_REQUESTS);
      // Nothing else is added: the send itself is the same request.
      expect(node.calls.filter((m) => m !== 'eth_getTransactionReceipt')).toEqual(plainNode.calls);
    });

    it('is ended as `timeout` by a flush that cannot wait, and polls no more after it', async () => {
      const { hashspan, traced, node } = wallets();
      await send(traced);
      expect(await hashspan.flush({ timeoutMs: 20 })).toBe(false);

      expect(confirmSpans()[0]?.attributes['error.type']).toBe('timeout');
      const polled = node.receiptCalls();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(node.receiptCalls()).toBeLessThanOrEqual(polled + 1);
    });

    it('counts towards maxBackgroundConfirmations', async () => {
      const { hashspan, traced } = wallets({}, { maxBackgroundConfirmations: 1 });
      await send(traced);
      const onReceipt = vi.fn();
      hashspan.watch(traced, { hash: `0x${'77'.repeat(32)}`, onReceipt });
      expect(onReceipt).toHaveBeenCalledWith(undefined);
      await hashspan.flush({ timeoutMs: 20 });
    });

    it('ends the confirm span as `timeout` when the call returns, with no request, when background confirmation is off', async () => {
      const { hashspan, traced, plain, node, plainNode } = wallets(
        { receiptAt: () => submittedReceipt() },
        { maxBackgroundConfirmations: 0 },
      );
      await send(traced);
      await send(plain);
      await hashspan.flush();

      const [confirm] = confirmSpans();
      expect(confirm?.attributes['error.type']).toBe('timeout');
      expect(toMs(confirm?.endTime)).toBe(toMs(sendSpan().endTime));
      expect(node.calls).toEqual(plainNode.calls);
    });

    it('records nothing of a receipt that names another transaction and another operation, or none, as for any wait', async () => {
      for (const multisig of [
        { hash: `0x${'99'.repeat(32)}`, status: 'success', type: 'transaction' },
        undefined,
        { hash: OPERATION.slice(0, 20) },
      ]) {
        tracing.exporter.reset();
        const { hashspan, traced } = wallets(
          { receiptAt: () => submittedReceipt({ multisig }) },
          SHORT,
        );
        await send(traced);
        await hashspan.flush();
        const confirms = confirmSpans();
        expect(confirms).toHaveLength(1);
        expect(confirms[0]?.attributes['error.type']).toBe('_OTHER');
        expect(confirms[0]?.attributes).not.toHaveProperty('blockchain.tx.status');
      }
    });

    it("joins a caller's wait for the operation's hash, and records the submitted transaction's receipt", async () => {
      let submitted = false;
      const { hashspan, traced } = wallets(
        { receiptAt: () => (submitted ? submittedReceipt() : null) },
        SHORT,
      );
      await send(traced);
      submitted = true;
      const receipt = await traced.waitForTransactionReceipt({ hash: OPERATION });
      await hashspan.flush();

      expect(receipt.transactionHash).toBe(SUBMITTED);
      const confirms = confirmSpans();
      expect(confirms).toHaveLength(1);
      expect(confirms[0]?.attributes['blockchain.tx.status']).toBe('success');
      expect(confirms[0]?.attributes).not.toHaveProperty('blockchain.tx.replacement.hash');
    });
  },
);
