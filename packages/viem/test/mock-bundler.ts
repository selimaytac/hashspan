import { createPublicClient, custom, encodeFunctionResult, RpcRequestError } from 'viem';
import {
  entryPoint07Abi,
  entryPoint07Address,
  type SmartAccount,
  toSmartAccount,
} from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';

export const SENDER = '0x1111111111111111111111111111111111111111' as const;
export const RECIPIENT = '0x2222222222222222222222222222222222222222' as const;
export const PAYMASTER = '0x3333333333333333333333333333333333333333' as const;
export const USER_OP_HASH = `0x${'a1'.repeat(32)}` as const;
export const BUNDLE_HASH = `0x${'b2'.repeat(32)}` as const;
/** A 4337 nonce with key 1 and sequence number 5: a bundler returns it as a hex string. */
export const NONCE = (1n << 64n) | 5n;

export interface MockBundlerOptions {
  chainIdHex?: string;
  /** Answers `eth_chainId` instead of `chainIdHex`. */
  chainId?: () => string | Promise<string>;
  /** Fields merged into the default user operation receipt; `null` means "not included yet". */
  receipt?: Record<string, unknown> | null;
  /** Error of `eth_getUserOperationReceipt`, as a bundler's JSON-RPC error. */
  receiptError?: { code: number; message: string };
  /** Error of `eth_sendUserOperation`, as a bundler's JSON-RPC error. */
  sendError?: { code: number; message: string };
  /** Called with each request's method as the request starts, in the context it was made in. */
  onRequest?: (method: string) => void;
}

/**
 * EIP-1193 transport of a bundler and its node, answering what viem's `sendUserOperation` and
 * `waitForUserOperationReceipt` request when gas, fees and nonce are given.
 */
export function mockBundler(options: MockBundlerOptions = {}) {
  const calls: string[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      options.onRequest?.(method);
      switch (method) {
        case 'eth_chainId':
          return options.chainId ? options.chainId() : (options.chainIdHex ?? '0x14a34');
        case 'eth_getCode':
          // The smart account is deployed: no factory data.
          return '0x01';
        case 'eth_call':
          return encodeFunctionResult({
            abi: entryPoint07Abi,
            functionName: 'getNonce',
            result: NONCE,
          });
        case 'eth_sendUserOperation':
          if (options.sendError) {
            throw new RpcRequestError({ body: { params }, error: options.sendError, url: 'mock' });
          }
          return USER_OP_HASH;
        case 'eth_getUserOperationReceipt':
          if (options.receiptError) {
            throw new RpcRequestError({
              body: { params },
              error: options.receiptError,
              url: 'mock',
            });
          }
          if (options.receipt === null) return null;
          return {
            userOpHash: USER_OP_HASH,
            entryPoint: entryPoint07Address,
            sender: SENDER,
            nonce: `0x${NONCE.toString(16)}`,
            actualGasCost: '0x1cbe991a08',
            actualGasUsed: '0x181cd',
            success: true,
            logs: [],
            receipt: {
              transactionHash: BUNDLE_HASH,
              transactionIndex: '0x0',
              blockHash: `0x${'cd'.repeat(32)}`,
              blockNumber: '0x2a',
              from: RECIPIENT,
              to: entryPoint07Address,
              cumulativeGasUsed: '0x30000',
              gasUsed: '0x30000',
              effectiveGasPrice: '0x3b9aca00',
              contractAddress: null,
              logs: [],
              logsBloom: `0x${'00'.repeat(256)}`,
              status: '0x1',
              type: '0x2',
            },
            ...options.receipt,
          };
        default:
          throw new Error(`mock bundler: unexpected method ${method}`);
      }
    },
  });
  return { transport, calls };
}

/** A smart account whose signatures are fixed bytes, for a bundler that checks none. */
export function stubAccount(
  transport: ReturnType<typeof mockBundler>['transport'],
): Promise<SmartAccount> {
  return toSmartAccount({
    // The account's own client needs a chain for its nonce key, whatever the bundler client's chain.
    client: createPublicClient({ chain: baseSepolia, transport }),
    entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: '0.7' },
    getAddress: async () => SENDER,
    encodeCalls: async () => '0x',
    decodeCalls: async () => [],
    getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
    getStubSignature: async () => `0x${'11'.repeat(65)}`,
    signMessage: async () => `0x${'11'.repeat(65)}`,
    signTypedData: async () => `0x${'11'.repeat(65)}`,
    signUserOperation: async () => `0x${'11'.repeat(65)}`,
  });
}

/** Gas and fees given explicitly, so viem asks the bundler for no estimate. */
export const GAS = {
  callGasLimit: 100_000n,
  verificationGasLimit: 100_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymasterVerificationGasLimit: 0n,
  paymasterPostOpGasLimit: 0n,
} as const;
