// The scripted flows of the dev-node matrix, run in order on one fresh node from genesis. Every compared transaction is
// signed locally with Anvil's well-known accounts and sent with eth_sendRawTransaction, so a node that does not sign
// for them (Geth) runs the same flows once the setup has funded them. Each flow turns the node's answers into rows
// (diff.mjs); a flow whose probe says the node lacks it is `unsupported`, and a flow that throws is `failed`, both kept
// apart from differences.
import { createHash } from 'node:crypto';
import { fromRlp, toHex, toRlp } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  CALL,
  CUSTOM_SELECTOR,
  ERROR_SELECTOR,
  INITCODE,
  PING_TOPIC,
  RUNTIME,
} from './contract.mjs';
import { recordedRow, regressionRow, schemaRows, specRow } from './diff.mjs';
import { errorOf, fieldsOf, kindOf, receiptValues, sanitize } from './rpc.mjs';
import { errorCodes } from './schemas.mjs';

/** Anvil's well-known mnemonic, which Anvil, Hardhat and Reth prefund by default. */
export const MNEMONIC = 'test test test test test test test test test test test junk';

/** The well-known account at an index of the mnemonic. */
export const accountAt = (index) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

/** Which well-known account each part of the flows uses, so their nonces never mix. */
export const ROLES = { sender: 0, authority: 1, blob: 2, invalid: 3 };

/** The address value transfers go to. */
export const SINK = '0x000000000000000000000000000000000000dEaD';

/** What the Geth setup sends each role's account from the faucet: 1,000 ETH. */
export const FUNDING = 1000n * 10n ** 18n;

const GWEI = 10n ** 9n;
const TIP = GWEI;
/** How many eth_sendTransaction calls the concurrency flow sends at once (foundry#17354). */
export const CONCURRENT = 5;

/** The zero blob of the EIP-4844 flow: its KZG commitment and every proof are the point at infinity. */
export const BLOB = `0x${'00'.repeat(131072)}`;
export const ZERO_COMMITMENT = `0xc0${'00'.repeat(47)}`;
/** The cell proofs of a blob in the EIP-7594 wrapper (Osaka): 128 per blob. */
export const CELLS_PER_BLOB = 128;

/** The versioned hash of a KZG commitment (EIP-4844): 0x01 and the last 31 bytes of its SHA-256. */
export function versionedHash(commitment) {
  const digest = createHash('sha256')
    .update(Buffer.from(commitment.slice(2), 'hex'))
    .digest('hex');
  return `0x01${digest.slice(2)}`;
}

/**
 * The network form of a signed blob transaction: the EIP-7594 wrapper (`v1`, with a version byte and cell proofs) or
 * the EIP-4844 one (`v0`, one proof per blob), around the signed transaction without its sidecar.
 */
export function blobWrapper(signed, version) {
  if (!signed.startsWith('0x03')) throw new Error('not a blob transaction');
  const fields = fromRlp(`0x${signed.slice(4)}`);
  const body =
    version === 'v1'
      ? [fields, '0x01', [BLOB], [ZERO_COMMITMENT], Array(CELLS_PER_BLOB).fill(ZERO_COMMITMENT)]
      : [fields, [BLOB], [ZERO_COMMITMENT], [ZERO_COMMITMENT]];
  return `0x03${toRlp(body).slice(2)}`;
}

/** Collects the rows and the calls of one flow. */
function recorder(flow, spec) {
  const checks = [];
  const calls = [];
  const r = {
    checks,
    calls,
    /** Records that a call was made and whether it answered with a result or an error. */
    log(call, method, answer) {
      calls.push({ call, method, answer: answer.error ? 'error' : 'result' });
      return answer;
    },
    spec: (row) => checks.push(specRow({ flow, ...row })),
    recorded: (row) => checks.push(recordedRow({ flow, ...row })),
    regression: (row) => checks.push(regressionRow({ flow, ...row })),
    /** The schema rows of a result, or the error rows when the call failed. */
    schema(call, method, answer, extra = {}) {
      if (answer.error) return r.error(call, method, answer);
      checks.push(...schemaRows(spec, { flow, call, method, result: answer.result, ...extra }));
    },
    /**
     * The rows of an error: the code (a `spec` row when the spec states it, with the codes of the method's error
     * groups as the other spec row) and the message and the data shape, recorded.
     */
    error(call, method, answer, { code, ref, known, cause, data } = {}) {
      const got = errorOf(answer.error ?? {});
      if (code !== undefined)
        r.spec({ call, field: 'code', ref, expected: code, got: got.code, known });
      else r.recorded({ call, field: 'code', got: got.code });
      const listed = errorCodes(spec, method);
      if (listed !== undefined && answer.error) {
        r.spec({
          call,
          field: 'code in error groups',
          ref: `execution-apis ${method} error-groups`,
          expected: 'listed',
          got: listed.includes(got.code) ? 'listed' : 'not listed',
        });
      }
      r.recorded({ call, field: 'message', got: got.message, cause });
      if (data !== undefined) {
        r.spec({
          call,
          field: 'data',
          ref: data.ref,
          expected: data.expected,
          got: got.data.slice(0, 10),
        });
      } else r.recorded({ call, field: 'data', got: got.data });
    },
    /** The rows of a receipt: schema, type and status, the values that do not differ by design, and its fields. */
    receipt(call, answer, { type, status, byDesign } = {}) {
      if (answer.error) return r.error(call, 'eth_getTransactionReceipt', answer);
      if (answer.result === null) {
        r.spec({ call, field: 'receipt', ref: 'mined', expected: 'present', got: 'null' });
        return;
      }
      r.schema(call, 'eth_getTransactionReceipt', answer, { byDesign });
      const values = receiptValues(answer.result);
      if (type !== undefined) {
        r.spec({
          call,
          field: 'type',
          ref: 'receipt.yaml type',
          expected: type,
          got: values.type ?? 'absent',
        });
      }
      if (status !== undefined) {
        r.spec({
          call,
          field: 'status',
          ref: 'receipt.yaml status (1 success, 0 failure)',
          expected: status,
          got: values.status ?? 'absent',
        });
      }
      for (const key of ['gasUsed', 'logs', 'contractAddress', 'blobGasUsed']) {
        if (values[key] !== undefined) r.recorded({ call, field: key, got: values[key] });
      }
      r.recorded({ call, field: 'fields', got: fieldsOf(answer.result) });
    },
  };
  return r;
}

/** Waits for a node answer to a hash: the receipt, or the error of the send. */
async function sendAndMine(ctx, r, call, raw) {
  const sent = r.log(
    call,
    'eth_sendRawTransaction',
    await ctx.rpc.call('eth_sendRawTransaction', [raw]),
  );
  if (sent.error) return { sent };
  const receipt = r.log(call, 'eth_getTransactionReceipt', await ctx.rpc.receipt(sent.result));
  return { sent, receipt, hash: sent.result };
}

/** The fees of the next transaction: base fee of the latest block times two, plus a 1 gwei tip. */
async function feesOf(ctx) {
  const latest = await ctx.rpc.call('eth_getBlockByNumber', ['latest', false]);
  const base = BigInt(latest.result?.baseFeePerGas ?? '0x0');
  return {
    base,
    maxFeePerGas: 2n * base + TIP,
    maxPriorityFeePerGas: TIP,
    gasPrice: 2n * base + TIP,
  };
}

/** The pending nonce of an account. */
async function nonceOf(ctx, address) {
  const answer = await ctx.rpc.call('eth_getTransactionCount', [address, 'pending']);
  if (answer.error) throw new Error(`eth_getTransactionCount: ${sanitize(answer.error.message)}`);
  return Number(BigInt(answer.result));
}

/** Signs a transaction of a role's account with the chain id and its pending nonce. */
async function sign(ctx, role, tx) {
  const account = ctx.accounts[role];
  const nonce = tx.nonce ?? (await nonceOf(ctx, account.address));
  return account.signTransaction({ chainId: ctx.chainId, nonce, ...tx });
}

/** Whether a receipt's effectiveGasPrice follows the formula of receipt.yaml for the transaction's fees. */
async function effectiveGasPriceRow(ctx, r, call, receipt, tx) {
  if (!receipt?.result) return;
  const block = await ctx.rpc.call('eth_getBlockByNumber', [receipt.result.blockNumber, false]);
  const base = BigInt(block.result?.baseFeePerGas ?? '0x0');
  const expected =
    tx.gasPrice !== undefined
      ? tx.gasPrice
      : base + [tx.maxFeePerGas - base, tx.maxPriorityFeePerGas].reduce((a, b) => (a < b ? a : b));
  r.spec({
    call,
    field: 'effectiveGasPrice',
    ref: 'receipt.yaml effectiveGasPrice formula',
    expected: 'formula holds',
    got:
      BigInt(receipt.result.effectiveGasPrice ?? '0x0') === expected ? 'formula holds' : 'differs',
  });
}

/** A value transfer of one type, with its receipt rows. */
function transfer(id, type, extra) {
  return {
    id,
    async run(ctx, r) {
      const fees = await feesOf(ctx);
      const tx = {
        to: SINK,
        value: 1n,
        gas: 50_000n,
        ...(type === '0x0' || type === '0x1'
          ? { gasPrice: fees.gasPrice }
          : { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
        ...extra,
      };
      const raw = await sign(ctx, 'sender', tx);
      const { sent, receipt, hash } = await sendAndMine(ctx, r, 'send', raw);
      r.schema('send', 'eth_sendRawTransaction', sent);
      if (!receipt) return;
      r.receipt('receipt', receipt, { type, status: '0x1' });
      await effectiveGasPriceRow(ctx, r, 'receipt', receipt, tx);
      ctx.hashes[id] = hash;
    },
  };
}

/** Sends a call to the contract with a fixed gas limit and records its receipt. */
async function contractCall(ctx, r, call, data, gas, status) {
  const fees = await feesOf(ctx);
  const raw = await sign(ctx, 'sender', {
    to: ctx.contract,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const { sent, receipt, hash } = await sendAndMine(ctx, r, call, raw);
  if (sent.error) return r.error(call, 'eth_sendRawTransaction', sent);
  r.receipt(`${call} receipt`, receipt, { type: '0x2', status });
  return { receipt, hash };
}

const needsContract = (ctx) => {
  if (!ctx.contract) throw new Error('the deploy flow did not deploy the contract');
};

/**
 * The flows, in the order they run. `needs` names the probe that must say `supported`.
 * @type {{ id: string, needs?: string, run: (ctx: any, r: any) => Promise<unknown> }[]}
 */
export const FLOWS = [
  {
    id: 'deploy',
    async run(ctx, r) {
      const fees = await feesOf(ctx);
      const raw = await sign(ctx, 'sender', {
        data: INITCODE,
        gas: 300_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const { sent, receipt } = await sendAndMine(ctx, r, 'send', raw);
      if (sent.error) return r.error('send', 'eth_sendRawTransaction', sent);
      r.receipt('receipt', receipt, { type: '0x2', status: '0x1' });
      ctx.contract = receipt.result?.contractAddress ?? undefined;
      needsContract(ctx);
      const code = r.log(
        'code',
        'eth_getCode',
        await ctx.rpc.call('eth_getCode', [ctx.contract, 'latest']),
      );
      r.recorded({
        call: 'code',
        field: 'runtime',
        got: code.result === RUNTIME ? 'as deployed' : kindOf(code.result),
      });
    },
  },
  transfer('legacy', '0x0', {}),
  transfer('eip2930', '0x1', { type: 'eip2930', accessList: [{ address: SINK, storageKeys: [] }] }),
  transfer('eip1559', '0x2', {}),
  {
    id: 'logs',
    async run(ctx, r) {
      needsContract(ctx);
      const { receipt } = (await contractCall(ctx, r, 'emit', CALL.emit, 100_000n, '0x1')) ?? {};
      const topic = receipt?.result?.logs?.[0]?.topics?.[0];
      r.recorded({
        call: 'emit receipt',
        field: 'topic',
        got: topic === PING_TOPIC ? 'Ping(uint256)' : kindOf(topic ?? null),
      });
      const filter = { fromBlock: '0x0', toBlock: 'latest', address: ctx.contract };
      const logs = r.log('getLogs', 'eth_getLogs', await ctx.rpc.call('eth_getLogs', [filter]));
      r.schema('getLogs', 'eth_getLogs', logs);
      if (Array.isArray(logs.result)) {
        r.recorded({ call: 'getLogs', field: 'count', got: logs.result.length });
        r.recorded({ call: 'getLogs', field: 'fields', got: fieldsOf(logs.result[0]) });
      }
      const created = r.log(
        'newFilter',
        'eth_newFilter',
        await ctx.rpc.call('eth_newFilter', [filter]),
      );
      r.schema('newFilter', 'eth_newFilter', created);
      if (created.error) return;
      const filterLogs = r.log(
        'getFilterLogs',
        'eth_getFilterLogs',
        await ctx.rpc.call('eth_getFilterLogs', [created.result]),
      );
      r.schema('getFilterLogs', 'eth_getFilterLogs', filterLogs);
      if (Array.isArray(filterLogs.result)) {
        r.recorded({ call: 'getFilterLogs', field: 'count', got: filterLogs.result.length });
      }
      const removed = r.log(
        'uninstallFilter',
        'eth_uninstallFilter',
        await ctx.rpc.call('eth_uninstallFilter', [created.result]),
      );
      r.schema('uninstallFilter', 'eth_uninstallFilter', removed);
    },
  },
  {
    id: 'revert-reason',
    async run(ctx, r) {
      needsContract(ctx);
      const call = { from: ctx.accounts.sender.address, to: ctx.contract, data: CALL.reason };
      const revert = { code: 3, ref: 'execution-apis eth_call errors (3 execution reverted)' };
      const called = r.log('call', 'eth_call', await ctx.rpc.call('eth_call', [call, 'latest']));
      r.error('call', 'eth_call', called, {
        ...revert,
        cause: 'revert',
        data: {
          ref: 'execution-apis eth_call errors (raw EVM revert data)',
          expected: ERROR_SELECTOR,
        },
      });
      const estimated = r.log(
        'estimateGas',
        'eth_estimateGas',
        await ctx.rpc.call('eth_estimateGas', [call]),
      );
      r.error('estimateGas', 'eth_estimateGas', estimated, {
        code: 3,
        ref: 'execution-apis eth_estimateGas errors (3 execution reverted)',
        cause: 'revert',
        data: {
          ref: 'execution-apis eth_estimateGas errors (raw EVM revert data)',
          expected: ERROR_SELECTOR,
        },
      });
      await contractCall(ctx, r, 'send', CALL.reason, 100_000n, '0x0');
    },
  },
  {
    id: 'custom-error',
    async run(ctx, r) {
      needsContract(ctx);
      const call = { from: ctx.accounts.sender.address, to: ctx.contract, data: CALL.custom };
      const called = r.log('call', 'eth_call', await ctx.rpc.call('eth_call', [call, 'latest']));
      r.error('call', 'eth_call', called, {
        code: 3,
        ref: 'execution-apis eth_call errors (3 execution reverted)',
        cause: 'revert',
        data: {
          ref: 'execution-apis eth_call errors (raw EVM revert data)',
          expected: CUSTOM_SELECTOR,
        },
      });
    },
  },
  {
    id: 'out-of-gas',
    async run(ctx, r) {
      needsContract(ctx);
      const sent = await contractCall(ctx, r, 'send', CALL.loop, 50_000n, '0x0');
      if (sent?.receipt?.result) {
        r.recorded({
          call: 'send receipt',
          field: 'all gas used',
          got: sent.receipt.result.gasUsed === toHex(50_000n) ? 'yes' : 'no',
        });
      }
      const call = {
        from: ctx.accounts.sender.address,
        to: ctx.contract,
        data: CALL.loop,
        gas: toHex(100_000n),
      };
      const estimated = r.log(
        'estimateGas',
        'eth_estimateGas',
        await ctx.rpc.call('eth_estimateGas', [call]),
      );
      if (estimated.error) r.error('estimateGas', 'eth_estimateGas', estimated, { cause: 'gas' });
      else r.recorded({ call: 'estimateGas', field: 'answer', got: 'a result' });
    },
  },
  {
    id: 'estimate-gas',
    async run(ctx, r) {
      const call = { from: ctx.accounts.sender.address, to: SINK, value: '0x1' };
      const estimated = r.log(
        'transfer',
        'eth_estimateGas',
        await ctx.rpc.call('eth_estimateGas', [call]),
      );
      r.schema('transfer', 'eth_estimateGas', estimated);
      if (!estimated.error) r.recorded({ call: 'transfer', field: 'value', got: estimated.result });
    },
  },
  {
    id: 'fee-history',
    async run(ctx, r) {
      const answer = r.log(
        'feeHistory',
        'eth_feeHistory',
        await ctx.rpc.call('eth_feeHistory', ['0x4', 'latest', [25, 75]]),
      );
      r.schema('feeHistory', 'eth_feeHistory', answer);
      const h = answer.result;
      if (!h) return;
      const blocks = h.gasUsedRatio?.length ?? 0;
      r.spec({
        call: 'feeHistory',
        field: 'baseFeePerGas length',
        ref: 'fee_market.yaml baseFeePerGas (includes the next block)',
        expected: 'blocks + 1',
        got:
          h.baseFeePerGas?.length === blocks + 1 ? 'blocks + 1' : String(h.baseFeePerGas?.length),
      });
      r.spec({
        call: 'feeHistory',
        field: 'reward length',
        ref: 'fee_market.yaml reward (one entry per block of the range)',
        expected: 'blocks',
        got: h.reward?.length === blocks ? 'blocks' : String(h.reward?.length ?? 'absent'),
      });
      r.recorded({ call: 'feeHistory', field: 'blocks', got: blocks });
      r.recorded({ call: 'feeHistory', field: 'fields', got: fieldsOf(h) });
    },
  },
  {
    id: 'block-receipts',
    needs: 'eth_getBlockReceipts',
    async run(ctx, r) {
      const hash = ctx.hashes.eip1559;
      if (!hash) throw new Error('the eip1559 flow sent no transaction');
      const receipt = await ctx.rpc.receipt(hash);
      const answer = r.log(
        'blockReceipts',
        'eth_getBlockReceipts',
        await ctx.rpc.call('eth_getBlockReceipts', [receipt.result?.blockNumber]),
      );
      r.schema('blockReceipts', 'eth_getBlockReceipts', answer);
      if (Array.isArray(answer.result)) {
        r.recorded({ call: 'blockReceipts', field: 'count', got: answer.result.length });
        r.recorded({
          call: 'blockReceipts',
          field: 'same as eth_getTransactionReceipt',
          got:
            JSON.stringify(answer.result.find((x) => x.transactionHash === hash)) ===
            JSON.stringify(receipt.result)
              ? 'yes'
              : 'no',
        });
      }
    },
  },
  {
    id: 'simulate',
    needs: 'eth_simulateV1',
    async run(ctx, r) {
      const payload = {
        blockStateCalls: [
          { calls: [{ from: ctx.accounts.sender.address, to: SINK, value: '0x1' }] },
        ],
      };
      const answer = r.log(
        'simulate',
        'eth_simulateV1',
        await ctx.rpc.call('eth_simulateV1', [payload, 'latest']),
      );
      r.schema('simulate', 'eth_simulateV1', answer);
      const calls = answer.result?.[0]?.calls;
      if (Array.isArray(calls))
        r.recorded({ call: 'simulate', field: 'call status', got: calls[0]?.status ?? 'absent' });
    },
  },
  {
    id: 'trace',
    needs: 'debug_traceTransaction',
    async run(ctx, r) {
      const hash = ctx.hashes.legacy;
      if (!hash) throw new Error('the legacy flow sent no transaction');
      const answer = r.log(
        'trace',
        'debug_traceTransaction',
        await ctx.rpc.call('debug_traceTransaction', [hash, {}]),
      );
      r.schema('trace', 'debug_traceTransaction', answer);
      if (answer.result && typeof answer.result === 'object') {
        r.recorded({ call: 'trace', field: 'gas', got: answer.result.gas ?? 'absent' });
        r.recorded({ call: 'trace', field: 'failed', got: answer.result.failed ?? 'absent' });
        r.recorded({ call: 'trace', field: 'fields', got: fieldsOf(answer.result) });
      }
    },
  },
  {
    id: 'eip7702',
    needs: 'eip7702',
    async run(ctx, r) {
      needsContract(ctx);
      const authority = ctx.accounts.authority;
      const authorization = await authority.signAuthorization({
        chainId: ctx.chainId,
        address: ctx.contract,
        nonce: await nonceOf(ctx, authority.address),
      });
      const fees = await feesOf(ctx);
      const raw = await sign(ctx, 'sender', {
        type: 'eip7702',
        to: authority.address,
        data: CALL.emit,
        gas: 200_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        authorizationList: [authorization],
      });
      const { sent, receipt } = await sendAndMine(ctx, r, 'send', raw);
      if (sent.error) return r.error('send', 'eth_sendRawTransaction', sent);
      r.receipt('receipt', receipt, { type: '0x4', status: '0x1' });
      const code = r.log(
        'code',
        'eth_getCode',
        await ctx.rpc.call('eth_getCode', [authority.address, 'latest']),
      );
      const designator = `0xef0100${ctx.contract.slice(2).toLowerCase()}`;
      r.recorded({
        call: 'code',
        field: 'delegation',
        got:
          String(code.result).toLowerCase() === designator
            ? 'to the contract'
            : kindOf(code.result ?? null),
      });
    },
  },
  {
    id: 'eip4844',
    needs: 'eip4844',
    async run(ctx, r) {
      const fees = await feesOf(ctx);
      const signed = await sign(ctx, 'blob', {
        type: 'eip4844',
        to: SINK,
        gas: 21_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerBlobGas: GWEI,
        blobVersionedHashes: [versionedHash(ZERO_COMMITMENT)],
      });
      // The EIP-7594 wrapper first (Osaka), the EIP-4844 one if the node refuses it.
      let accepted = 'none';
      let mined;
      for (const version of ['v1', 'v0']) {
        const result = await sendAndMine(ctx, r, `send ${version}`, blobWrapper(signed, version));
        if (result.sent.error) {
          r.error(`send ${version}`, 'eth_sendRawTransaction', result.sent);
          continue;
        }
        accepted = version;
        mined = result.receipt;
        break;
      }
      r.recorded({ call: 'send', field: 'wrapper accepted', got: accepted });
      if (mined) r.receipt('receipt', mined, { type: '0x3', status: '0x1' });
    },
  },
  {
    id: 'invalid-input',
    async run(ctx, r) {
      const fees = await feesOf(ctx);
      const used = await sign(ctx, 'sender', {
        nonce: 0,
        to: SINK,
        value: 2n,
        gas: 21_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const low = r.log(
        'nonce too low',
        'eth_sendRawTransaction',
        await ctx.rpc.call('eth_sendRawTransaction', [used]),
      );
      r.error('nonce too low', 'eth_sendRawTransaction', low, { cause: 'nonce' });
      const cheap = await sign(ctx, 'invalid', {
        to: SINK,
        value: 1n,
        gas: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      });
      const under = r.log(
        'underpriced',
        'eth_sendRawTransaction',
        await ctx.rpc.call('eth_sendRawTransaction', [cheap]),
      );
      if (under.error) r.error('underpriced', 'eth_sendRawTransaction', under, { cause: 'fee' });
      else r.recorded({ call: 'underpriced', field: 'answer', got: 'accepted' });
      const bad = r.log(
        'bad params',
        'eth_getBalance',
        await ctx.rpc.call('eth_getBalance', ['nope', 'latest']),
      );
      r.error('bad params', 'eth_getBalance', bad, {
        code: -32602,
        ref: 'rpc-standard-errors.yaml (-32602 Invalid params)',
        cause: 'params',
      });
      const unknown = r.log(
        'unknown method',
        'hashspan_unknownMethod',
        await ctx.rpc.call('hashspan_unknownMethod'),
      );
      r.error('unknown method', 'hashspan_unknownMethod', unknown, {
        code: -32601,
        ref: 'rpc-standard-errors.yaml (-32601 Method not found)',
        known: ctx.node.known?.includes('edr#1258') ? 'edr#1258' : undefined,
        cause: 'method',
      });
    },
  },
  {
    id: 'concurrent-send',
    needs: 'eth_sendTransaction',
    async run(ctx, r) {
      const accounts = await ctx.rpc.call('eth_accounts');
      const from = accounts.result[0];
      const answers = await Promise.all(
        Array.from({ length: CONCURRENT }, () =>
          ctx.rpc.call('eth_sendTransaction', [
            { from, to: SINK, value: '0x1', gas: toHex(21_000n) },
          ]),
        ),
      );
      for (const [i, a] of answers.entries()) r.log(`send ${i}`, 'eth_sendTransaction', a);
      const nonces = [];
      for (const a of answers) {
        if (a.error) continue;
        await ctx.rpc.receipt(a.result);
        const tx = await ctx.rpc.call('eth_getTransactionByHash', [a.result]);
        if (tx.result?.nonce !== undefined) nonces.push(tx.result.nonce);
      }
      r.recorded({
        call: 'sends',
        field: 'errors',
        got: answers.filter((a) => a.error).map((a) => errorOf(a.error).message),
      });
      r.regression({
        call: 'sends',
        field: 'distinct nonces',
        expected: CONCURRENT,
        got: new Set(nonces).size,
        upstream: 'foundry#17354',
        known: ctx.node.known?.includes('foundry#17354') ? 'foundry#17354' : undefined,
      });
    },
  },
];

/**
 * Runs the flows on a node that answers at `ctx.rpc`; returns one entry per flow with its status, calls and rows.
 * `ctx.probes` is what probes.mjs found; `ctx.node` the target (its `known` list).
 */
export async function runFlows(ctx, spec, flows = FLOWS) {
  ctx.accounts ??= Object.fromEntries(
    Object.entries(ROLES).map(([role, i]) => [role, accountAt(i)]),
  );
  ctx.hashes ??= {};
  const out = [];
  for (const flow of flows) {
    if (flow.needs && ctx.probes?.[flow.needs] !== 'supported') {
      out.push({ flow: flow.id, status: 'unsupported', needs: flow.needs, calls: [], checks: [] });
      continue;
    }
    const r = recorder(flow.id, spec);
    try {
      await flow.run(ctx, r);
      out.push({ flow: flow.id, status: 'run', calls: r.calls, checks: r.checks });
    } catch (error) {
      out.push({
        flow: flow.id,
        status: 'failed',
        error: sanitize(error?.shortMessage ?? error?.message ?? error),
        calls: r.calls,
        checks: r.checks,
      });
    }
  }
  return out;
}
