import { custom } from 'viem';

export const FROM = '0x1111111111111111111111111111111111111111' as const;
export const TO = '0x2222222222222222222222222222222222222222' as const;
export const HASH = `0x${'ab'.repeat(32)}` as const;

export interface MockOptions {
  chainIdHex?: string;
  /** Receipt fields merged into the default successful receipt; `null` means "not mined yet". */
  receipt?: Record<string, unknown> | null;
  sendError?: { code: number; message: string };
}

/** EIP-1193 transport answering the handful of methods the adapter's code paths use. */
export function mockTransport(options: MockOptions = {}) {
  const calls: string[] = [];
  const transport = custom({
    async request({ method }: { method: string; params?: unknown }) {
      calls.push(method);
      switch (method) {
        case 'eth_chainId':
          return options.chainIdHex ?? '0x2105';
        case 'eth_sendTransaction':
          if (options.sendError)
            throw Object.assign(new Error(options.sendError.message), options.sendError);
          return HASH;
        case 'eth_blockNumber':
          return '0x7b';
        case 'eth_getTransactionReceipt':
          if (options.receipt === null) return null;
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
  return { transport, calls };
}
