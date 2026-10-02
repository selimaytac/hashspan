// An in-process stand-in for an ERC-4337 bundler, for the user operation tests on Anvil that need no real EntryPoint.
// It answers the bundler methods viem's `sendUserOperation` and `waitForUserOperationReceipt` use, puts each operation
// into its own bundle transaction (`handleOps` on the EntryPoint, sent from a bundler account) and builds receipts
// from that transaction's logs, as a bundler does. real-bundler.int.test.ts checks the same paths through Alto, a real
// bundler installed outside the workspace (docs/adr/0021, Implementation notes); the receipts here are shaped like
// Alto's.
import {
  type Address,
  custom,
  decodeEventLog,
  type Hex,
  type PublicClient,
  toHex,
  type WalletClient,
} from 'viem';
import {
  entryPoint07Address,
  formatUserOperation,
  getUserOperationHash,
  toPackedUserOperation,
} from 'viem/account-abstraction';
import { testEntryPointAbi } from './entry-point/test-entry-point.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface TestBundler {
  transport: ReturnType<typeof custom>;
  /** Bundle transaction of each user operation hash, lower-cased. */
  bundles: Map<string, Hex>;
}

/** A bundler on `reader`'s chain that sends bundles with `executor`. */
export function testBundler(reader: PublicClient, executor: WalletClient): TestBundler {
  const bundles = new Map<string, Hex>();

  const send = async (rpcOperation: Record<string, unknown>, entryPoint: Address): Promise<Hex> => {
    const operation = formatUserOperation(rpcOperation as never);
    const packed = toPackedUserOperation(operation);
    const chainId = await reader.getChainId();
    const hash = getUserOperationHash({
      chainId,
      entryPointAddress: entryPoint,
      entryPointVersion: '0.7',
      userOperation: operation,
    });
    // The stand-in EntryPoint must hash as v0.7 does, or the receipts would not match the operations.
    const onChain = await reader.readContract({
      address: entryPoint,
      abi: testEntryPointAbi,
      functionName: 'getUserOpHash',
      args: [packed],
    });
    if (onChain !== hash) throw new Error(`EntryPoint hash ${onChain} differs from ${hash}`);
    const bundle = await executor.writeContract({
      address: entryPoint,
      abi: testEntryPointAbi,
      functionName: 'handleOps',
      args: [[packed], executor.account?.address as Address],
      account: executor.account as never,
      chain: reader.chain,
      gas: 5_000_000n,
    });
    bundles.set(hash.toLowerCase(), bundle);
    return hash;
  };

  const receipt = async (userOpHash: Hex): Promise<Record<string, unknown> | null> => {
    const bundle = bundles.get(userOpHash.toLowerCase());
    if (!bundle) return null;
    // The node's raw receipt, which viem formats like any transaction receipt.
    const raw = (await reader.request({
      method: 'eth_getTransactionReceipt',
      params: [bundle],
    })) as { logs: { topics: [Hex, ...Hex[]]; data: Hex }[] } | null;
    if (!raw) return null;
    const events = raw.logs.flatMap((log) => {
      try {
        const event = decodeEventLog({
          abi: testEntryPointAbi,
          data: log.data,
          topics: log.topics,
        });
        return event.args.userOpHash.toLowerCase() === userOpHash.toLowerCase() ? [event] : [];
      } catch {
        return [];
      }
    });
    const operation = events.find((event) => event.eventName === 'UserOperationEvent');
    if (operation?.eventName !== 'UserOperationEvent') return null;
    const revert = events.find((event) => event.eventName === 'UserOperationRevertReason');
    const { args } = operation;
    // Shaped like Alto's answer (real-bundler.int.test.ts): the nonce as a hex string, the EntryPoint lower-cased, no
    // paymaster when none paid.
    return {
      userOpHash,
      entryPoint: entryPoint07Address.toLowerCase(),
      sender: args.sender,
      nonce: toHex(args.nonce),
      actualGasCost: toHex(args.actualGasCost),
      actualGasUsed: toHex(args.actualGasUsed),
      success: args.success,
      ...(args.paymaster !== ZERO_ADDRESS ? { paymaster: args.paymaster } : {}),
      ...(revert?.eventName === 'UserOperationRevertReason'
        ? { reason: revert.args.revertReason }
        : {}),
      logs: [],
      receipt: raw,
    };
  };

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const args = (params ?? []) as unknown[];
      switch (method) {
        case 'eth_chainId':
          return toHex(await reader.getChainId());
        case 'eth_supportedEntryPoints':
          return [entryPoint07Address];
        case 'eth_estimateUserOperationGas':
          return {
            preVerificationGas: toHex(50_000),
            verificationGasLimit: toHex(200_000),
            callGasLimit: toHex(500_000),
            paymasterVerificationGasLimit: toHex(0),
            paymasterPostOpGasLimit: toHex(0),
          };
        case 'eth_sendUserOperation':
          return send(args[0] as Record<string, unknown>, args[1] as Address);
        case 'eth_getUserOperationReceipt':
          return receipt(args[0] as Hex);
        default:
          // Node methods, such as the fee estimate of `prepareUserOperation`.
          return reader.request({ method, params } as never);
      }
    },
  });
  return { transport, bundles };
}
