import { custom, RpcRequestError, type Transport } from 'viem';

export const FROM = '0x1111111111111111111111111111111111111111' as const;
export const TO = '0x2222222222222222222222222222222222222222' as const;
export const HASH = `0x${'ab'.repeat(32)}` as const;

export interface MockOptions {
  chainIdHex?: string;
  /** Answers `eth_chainId` instead of `chainIdHex`, e.g. late, never, or differently per call. */
  chainId?: () => string | Promise<string>;
  /** Receipt fields merged into the default successful receipt; `null` means "not mined yet". */
  receipt?: Record<string, unknown> | null;
  /** Receipt fields per `eth_getTransactionReceipt` call (the first is 1), merged after `receipt`. */
  receiptAt?: (call: number) => Record<string, unknown>;
  /** Transaction fields merged into the default transaction, such as its `input`; a function gets the hash asked for. */
  transaction?: Record<string, unknown> | ((hash: unknown) => Record<string, unknown>);
  /** Fails `eth_sendTransaction` and `eth_sendRawTransactionSync` with this error. */
  sendError?: { code: number; message: string };
  /** Fails only this `eth_sendTransaction` call (the first is 1) with `sendError`. */
  sendErrorOnCall?: number;
  /** Methods that never answer, like an unresponsive provider. */
  hangOn?: string[];
  /** Methods that fail with a non-retryable JSON-RPC error (invalid params). */
  failOn?: string[];
  /** Delays the answer to `eth_sendTransaction`. */
  sendDelayMs?: number;
  /** Revert data returned by `eth_call`; the call succeeds when undefined. */
  callRevertData?: string;
  /** With `callRevertData`, which block tags of `eth_call` revert (default: all), e.g. only the receipt's block. */
  callRevertsOn?: (blockTag: unknown) => boolean;
  /** Delays every `eth_call` answer by this many milliseconds. */
  callDelayMs?: number;
  /** Never answers `eth_call`, holding no timer or socket. */
  callHangs?: boolean;
  /** While this returns false, the transaction is pending (no receipt). */
  mined?: () => boolean;
  /** Returns a new block number on every `eth_blockNumber`, so viem keeps polling. */
  advanceBlocks?: boolean;
  /** Blocks contain the mined transaction, as they do on a node that returns a receipt late. */
  blockIncludesTransaction?: boolean;
  /** Answer to `wallet_sendCalls`: the batch id, or a JSON-RPC error (e.g. -32601 when the wallet lacks it). */
  sendCalls?: { id: string } | { error: { code: number; message: string } };
  /** Answers `wallet_getCallsStatus` per call (the first is 1); merged into a confirmed status. */
  callsStatus?: (call: number) => Record<string, unknown>;
  /** Called with each request's method as the request starts, in the context it was made in. */
  onRequest?: (method: string) => void;
  /** How often viem retries a failed request (viem's default: 3, with a growing delay). */
  retryCount?: number;
}

/** EIP-1193 transport answering the handful of methods the adapter's code paths use. */
export function mockTransport(options: MockOptions = {}) {
  const calls: string[] = [];
  const requests: { method: string; params?: unknown }[] = [];
  let block = 0x7b;
  let receiptCalls = 0;
  let statusCalls = 0;
  let sendCalls = 0;
  const transaction = (hash?: unknown) => ({
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
    ...(typeof options.transaction === 'function'
      ? options.transaction(hash)
      : options.transaction),
  });
  const minedReceipt = () => ({
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
    ...options.receiptAt?.(++receiptCalls),
  });
  const answering = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      requests.push({ method, params });
      options.onRequest?.(method);
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
          sendCalls++;
          if (
            options.sendError &&
            (options.sendErrorOnCall === undefined || options.sendErrorOnCall === sendCalls)
          )
            throw Object.assign(new Error(options.sendError.message), options.sendError);
          return HASH;
        case 'eth_blockNumber':
          return `0x${(options.advanceBlocks ? block++ : block).toString(16)}`;
        case 'eth_getTransactionByHash':
          return transaction((params as unknown[] | undefined)?.[0]);
        case 'eth_call':
          if (options.callHangs) return new Promise(() => {});
          if (options.callDelayMs)
            await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
          if (options.callRevertData === undefined) return '0x';
          if (
            options.callRevertsOn &&
            !options.callRevertsOn((params as unknown[] | undefined)?.[1])
          ) {
            return '0x';
          }
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
            transactions: options.blockIncludesTransaction ? [transaction()] : [],
            uncles: [],
            size: '0x0',
            stateRoot: `0x${'00'.repeat(32)}`,
            receiptsRoot: `0x${'00'.repeat(32)}`,
            transactionsRoot: `0x${'00'.repeat(32)}`,
            sha3Uncles: `0x${'00'.repeat(32)}`,
            mixHash: `0x${'00'.repeat(32)}`,
          };
        case 'eth_sendRawTransactionSync':
          // EIP-7966: sends and answers with the receipt once the transaction is mined.
          if (options.sendError) {
            throw new RpcRequestError({ body: {}, error: options.sendError, url: 'mock' });
          }
          return minedReceipt();
        case 'eth_getTransactionReceipt':
          if (options.receipt === null || options.mined?.() === false) return null;
          return minedReceipt();
        case 'wallet_sendCalls': {
          const answer = options.sendCalls ?? { id: '0xb47c4' };
          if ('error' in answer) {
            throw new RpcRequestError({ body: {}, error: answer.error, url: 'mock' });
          }
          return answer;
        }
        case 'wallet_getCallsStatus':
          return {
            version: '2.0.0',
            id: (params as unknown[] | undefined)?.[0],
            chainId: options.chainIdHex ?? '0x2105',
            status: 200,
            atomic: true,
            receipts: [
              {
                transactionHash: HASH,
                blockHash: `0x${'cd'.repeat(32)}`,
                blockNumber: '0x7b',
                gasUsed: '0x5208',
                logs: [],
                status: '0x1',
              },
            ],
            ...options.callsStatus?.(++statusCalls),
          };
        default:
          throw new Error(`mock transport: unexpected method ${method}`);
      }
    },
  });
  const { retryCount } = options;
  const transport: Transport =
    retryCount === undefined ? answering : (params) => answering({ ...params, retryCount });
  return { transport, calls, requests };
}
