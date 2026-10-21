// The chain-mode section: modes in which a dev node emulates another chain, each on a fresh node of its own and
// compared with the shape a real chain was seen to return (experiments E2 and E9a), not with the other nodes, since
// Geth and Reth emulate no L2. The fields a mode adds are `by-design: <mode>`, never a schema difference. Only field
// names and kinds of the real chains are kept here, no value of them.
import { celo } from 'viem/chains';
import { recordedRow, regressionRow, schemaRows } from './diff.mjs';
import { accountAt, SINK } from './flows.mjs';
import { fieldsOf, kindOf } from './rpc.mjs';

/** The L1 fee fields of an OP Stack receipt (Ecotone and later, with the Isthmus operator fee). */
export const OP_RECEIPT_FIELDS = [
  'l1BaseFeeScalar',
  'l1BlobBaseFee',
  'l1BlobBaseFeeScalar',
  'l1Fee',
  'l1GasPrice',
  'l1GasUsed',
  'operatorFeeConstant',
  'operatorFeeScalar',
];
/** The fields a Tempo receipt adds. */
export const TEMPO_RECEIPT_FIELDS = ['feePayer', 'feeToken'];

/** OP Stack's L1Block predeploy and its two scalar getters (selectors of `baseFeeScalar()`, `blobBaseFeeScalar()`). */
export const L1_BLOCK = '0x4200000000000000000000000000000000000015';
export const SCALAR_GETTERS = { baseFeeScalar: '0xc5985918', blobBaseFeeScalar: '0x68d5dca6' };

/** Celo's cUSD, the fee currency the E2 runs paid in. */
export const CELO_FEE_CURRENCY = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

/** The receipt of a value-free 0x2 transaction with `data`, signed by the first well-known account. */
async function send1559(ctx, data, gas) {
  const block = await ctx.rpc.call('eth_getBlockByNumber', ['latest', false]);
  const base = BigInt(block.result?.baseFeePerGas ?? '0x0');
  const account = accountAt(0);
  const nonce = await ctx.rpc.call('eth_getTransactionCount', [account.address, 'pending']);
  const raw = await account.signTransaction({
    chainId: ctx.chainId,
    nonce: Number(BigInt(nonce.result)),
    to: SINK,
    data,
    gas,
    maxFeePerGas: 2n * base + 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 9n,
  });
  const sent = await ctx.rpc.call('eth_sendRawTransaction', [raw]);
  if (sent.error) return { sent };
  return { sent, receipt: await ctx.rpc.receipt(sent.result) };
}

const present = (receipt, fields) => fields.filter((f) => receipt && f in receipt);

/**
 * The modes. `node` is the target it runs on, `start` its mode arguments (Anvil) or network (Hardhat), `mode` the
 * by-design label, `reference` the real-chain shape and where it was recorded.
 * @type {any[]}
 */
export const CHAIN_MODES = [
  {
    id: 'hardhat-op',
    node: 'hardhat',
    start: { network: 'op' },
    mode: 'op',
    reference: {
      source:
        'E9a: OP Mainnet and Base hold non-zero baseFeeScalar and blobBaseFeeScalar in L1Block slot 3; a real OP receipt was not recorded',
      shape: { scalars: 'non-zero', receiptFields: OP_RECEIPT_FIELDS },
    },
    async run(ctx, rows) {
      for (const [name, selector] of Object.entries(SCALAR_GETTERS)) {
        const answer = await ctx.rpc.call('eth_call', [{ to: L1_BLOCK, data: selector }, 'latest']);
        rows.push(
          regressionRow({
            flow: 'hardhat-op',
            call: 'L1Block',
            field: name,
            expected: 'non-zero',
            got: answer.error ? 'error' : BigInt(answer.result ?? '0x0') > 0n ? 'non-zero' : 'zero',
            upstream: 'edr#1829',
          }),
        );
      }
      const { sent, receipt } = await send1559(ctx, `0x${'ab'.repeat(2000)}`, 500_000n);
      const r = receipt?.result;
      rows.push(
        regressionRow({
          flow: 'hardhat-op',
          call: 'receipt',
          field: 'l1Fee',
          expected: 'non-zero',
          got: sent.error
            ? 'send failed'
            : r?.l1Fee === undefined
              ? 'absent'
              : BigInt(r.l1Fee) > 0n
                ? 'non-zero'
                : 'zero',
          upstream: 'edr#1829',
        }),
      );
      receiptRows(ctx.spec, rows, 'hardhat-op', receipt, { mode: 'op', fields: OP_RECEIPT_FIELDS });
    },
  },
  {
    id: 'anvil-optimism',
    node: 'anvil',
    start: { args: ['--network', 'optimism', '--chain-id', '10'] },
    mode: 'optimism',
    reference: {
      source: 'E2: Anvil -n optimism stores no L1 data fee; a real OP receipt was not recorded',
      shape: { receiptFields: OP_RECEIPT_FIELDS },
    },
    async run(ctx, rows) {
      const { sent, receipt } = await send1559(ctx, `0x${'ab'.repeat(2000)}`, 500_000n);
      rows.push({
        flow: 'anvil-optimism',
        call: 'receipt',
        field: 'L1 fee fields',
        kind: 'by-design',
        mode: 'optimism',
        got: sent.error ? 'send failed' : present(receipt?.result, OP_RECEIPT_FIELDS),
        outcome: 'by-design',
      });
      receiptRows(ctx.spec, rows, 'anvil-optimism', receipt, {
        mode: 'optimism',
        fields: OP_RECEIPT_FIELDS,
      });
    },
  },
  {
    id: 'anvil-tempo',
    node: 'anvil',
    start: { args: ['--network', 'tempo'] },
    mode: 'tempo',
    reference: {
      source: 'E2: a Tempo mainnet receipt of a 0x2 transaction carries feeToken and feePayer',
      shape: { type: '0x2', receiptFields: TEMPO_RECEIPT_FIELDS },
    },
    async run(ctx, rows) {
      // Tempo refuses native value transfers, so the transaction carries data only.
      const { sent, receipt } = await send1559(ctx, '0x', 500_000n);
      const r = receipt?.result;
      rows.push(
        regressionRow({
          flow: 'anvil-tempo',
          call: 'receipt',
          field: 'fee fields on 0x2',
          expected: TEMPO_RECEIPT_FIELDS,
          got: sent.error
            ? 'send failed'
            : r?.type === '0x2'
              ? present(r, TEMPO_RECEIPT_FIELDS)
              : `type ${kindOf(r?.type ?? null)}`,
        }),
      );
      receiptRows(ctx.spec, rows, 'anvil-tempo', receipt, {
        mode: 'tempo',
        fields: TEMPO_RECEIPT_FIELDS,
      });
    },
  },
  {
    id: 'anvil-celo',
    node: 'anvil',
    start: { args: ['--celo', '--chain-id', '42220'] },
    mode: 'celo',
    reference: {
      source:
        'E2: Celo mainnet eth_fillTransaction with a fee currency returns a 0x7b (CIP-64) transaction',
      shape: { type: '0x7b' },
    },
    async run(ctx, rows) {
      const account = accountAt(0);
      const block = await ctx.rpc.call('eth_getBlockByNumber', ['latest', false]);
      const base = BigInt(block.result?.baseFeePerGas ?? '0x0');
      const raw = await account.signTransaction(
        {
          chainId: ctx.chainId,
          nonce: 0,
          to: SINK,
          data: '0x1234',
          gas: 100_000n,
          feeCurrency: CELO_FEE_CURRENCY,
          maxFeePerGas: 2n * base + 10n ** 9n,
          maxPriorityFeePerGas: 10n ** 9n,
        },
        { serializer: celo.serializers.transaction },
      );
      const sent = await ctx.rpc.call('eth_sendRawTransaction', [raw]);
      const receipt = sent.error ? undefined : await ctx.rpc.receipt(sent.result);
      rows.push(
        regressionRow({
          flow: 'anvil-celo',
          call: 'send 0x7b',
          field: 'receipt type',
          expected: '0x7b',
          got: sent.error ? `refused (${sent.error.code})` : (receipt?.result?.type ?? 'absent'),
          upstream: 'foundry#17462',
          known: ctx.node.known?.includes('foundry#17462') ? 'foundry#17462' : undefined,
        }),
      );
      if (receipt)
        receiptRows(ctx.spec, rows, 'anvil-celo', receipt, {
          mode: 'celo',
          fields: ['feeCurrency'],
        });
    },
  },
];

/** The modes of one node. */
export const modesOf = (node) => CHAIN_MODES.filter((m) => m.node === node);

/**
 * The rows of a chain mode's receipt: its schema, with the fields the mode adds as `by-design: <mode>`, and its field
 * list, recorded.
 */
export function receiptRows(spec, rows, flow, receipt, byDesign) {
  if (!receipt?.result) return;
  rows.push(
    ...schemaRows(spec, {
      flow,
      call: 'receipt',
      method: 'eth_getTransactionReceipt',
      result: receipt.result,
      byDesign,
    }),
    recordedRow({ flow, call: 'receipt', field: 'fields', got: fieldsOf(receipt.result) }),
  );
}
