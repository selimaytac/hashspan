import { custom, RpcRequestError } from 'viem';

export const FROM = '0x1111111111111111111111111111111111111111' as const;
export const TO = '0x2222222222222222222222222222222222222222' as const;
export const HASH = `0x${'ab'.repeat(32)}` as const;

export interface MockOptions {
  chainIdHex?: string;
  /** Answers `eth_chainId` instead of `chainIdHex`, e.g. late, never, or differently per call. */
  chainId?: () => string | Promise<string>;
  /** Receipt fields merged into the default successful receipt; `null` means "not mined yet". */
  receipt?: Record<string, unknown> | null;
  sendError?: { code: number; message: string };
  /** Methods that never answer, like an unresponsive provider. */
  hangOn?: string[];
  /** Methods that fail with a non-retryable JSON-RPC error (invalid params). */
  failOn?: string[];
  /** Delays the answer to `eth_sendTransaction`. */
  sendDelayMs?: number;
  /** Revert data returned by `eth_call`; the call succeeds when undefined. */
  callRevertData?: string;
  /** Delays every `eth_call` answer by this many milliseconds. */
  callDelayMs?: number;
  /** Never answers `eth_call`, holding no timer or socket. */
  callHangs?: boolean;
  /** While this returns false, the transaction is pending (no receipt). */
  mined?: () => boolean;
  /** Returns a new block number on every `eth_blockNumber`, so viem keeps polling. */
  advanceBlocks?: boolean;
}

/** EIP-1193 transport answering the handful of methods the adapter's code paths use. */
export function mockTransport(options: MockOptions = {}) {
  const calls: string[] = [];
  const requests: { method: string; params?: unknown }[] = [];
  let block = 0x7b;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      requests.push({ method, params });
      if (options.hangOn?.includes(method)) return new Promise(() => {});
      if (options.failOn?.includes(method)) {
        throw new RpcRequestError({
          body: {},
          error: { code: -32602, message: `mock: ${method} failed` },
          url: 'mock',
        });
      }
      switch (method) {
        case 'eth_chainId':
          return options.chainId ? options.chainId() : (options.chainIdHex ?? '0x2105');
        case 'eth_sendTransaction':
          if (options.sendDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
          }
          if (options.sendError)
            throw Object.assign(new Error(options.sendError.message), options.sendError);
          return HASH;
        case 'eth_blockNumber':
          return `0x${(options.advanceBlocks ? block++ : block).toString(16)}`;
        case 'eth_getTransactionByHash':
          return {
            hash: HASH,
            from: FROM,
            to: TO,
            input: '0xa9059cbb',
            value: '0x0',
            gas: '0x186a0',
            nonce: '0x0',
            blockHash: `0x${'cd'.repeat(32)}`,
            blockNumber: '0x7b',
            transactionIndex: '0x0',
            type: '0x2',
            chainId: options.chainIdHex ?? '0x2105',
            maxFeePerGas: '0x3b9aca00',
            maxPriorityFeePerGas: '0x1',
            accessList: [],
            v: '0x0',
            r: `0x${'11'.repeat(32)}`,
            s: `0x${'22'.repeat(32)}`,
            yParity: '0x0',
          };
        case 'eth_call':
          if (options.callHangs) return new Promise(() => {});
          if (options.callDelayMs)
            await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
          if (options.callRevertData === undefined) return '0x';
          // Shaped like a node's JSON-RPC error, so viem does not retry it.
          throw new RpcRequestError({
            body: {},
            error: { code: 3, message: 'execution reverted', data: options.callRevertData },
            url: 'mock',
          });
        case 'eth_getBlockByNumber':
          // An empty block: viem scans it for replacements while the receipt is missing.
          return {
            hash: `0x${'cd'.repeat(32)}`,
            parentHash: `0x${'00'.repeat(32)}`,
            number: `0x${block.toString(16)}`,
            timestamp: '0x0',
            nonce: '0x0000000000000000',
            difficulty: '0x0',
            gasLimit: '0x1c9c380',
            gasUsed: '0x0',
            miner: FROM,
            extraData: '0x',
            baseFeePerGas: '0x1',
            logsBloom: `0x${'00'.repeat(256)}`,
            transactions: [],
            uncles: [],
            size: '0x0',
            stateRoot: `0x${'00'.repeat(32)}`,
            receiptsRoot: `0x${'00'.repeat(32)}`,
            transactionsRoot: `0x${'00'.repeat(32)}`,
            sha3Uncles: `0x${'00'.repeat(32)}`,
            mixHash: `0x${'00'.repeat(32)}`,
          };
        case 'eth_getTransactionReceipt':
          if (options.receipt === null || options.mined?.() === false) return null;
          return {
            transactionHash: HASH,
            transactionIndex: '0x0',
            blockHash: `0x${'cd'.repeat(32)}`,
            blockNumber: '0x7b',
            from: FROM,
            to: TO,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x3b9aca00',
            contractAddress: null,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x2',
            ...options.receipt,
          };
        default:
          throw new Error(`mock transport: unexpected method ${method}`);
      }
    },
  });
  return { transport, calls, requests };
}
