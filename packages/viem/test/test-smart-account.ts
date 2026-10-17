// A smart account on the stand-in EntryPoint (entry-point/, at the v0.7 address), for the user operation tests on
// Anvil that go through test-bundler.ts: its calls run through the stand-in account's `execute` and `executeBatch`,
// and its signatures are fixed bytes, which the stand-in EntryPoint does not check.
import { type Address, type Client, encodeFunctionData, type Hex, type PublicClient } from 'viem';
import {
  entryPoint07Abi,
  entryPoint07Address,
  type SmartAccount,
  toSmartAccount,
} from 'viem/account-abstraction';
import {
  testAccountAbi,
  testAccountCode,
  testEntryPointCode,
} from './entry-point/test-entry-point.js';

const SIGNATURE = `0x${'11'.repeat(65)}` as const;

/** Puts the stand-in EntryPoint at the v0.7 address and a funded stand-in account at `account` on an Anvil node. */
export async function installTestEntryPoint(anvil: Client, account: Address): Promise<void> {
  const request = (method: string, params: unknown[]) =>
    anvil.request({ method: method as never, params: params as never });
  await request('anvil_setCode', [entryPoint07Address, testEntryPointCode as Hex]);
  await request('anvil_setCode', [account, testAccountCode as Hex]);
  await request('anvil_setBalance', [account, '0xde0b6b3a7640000']);
}

/** The smart account at `address`, a stand-in account, read through `client`. */
export function testSmartAccount(client: PublicClient, address: Address): Promise<SmartAccount> {
  return toSmartAccount({
    client,
    entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: '0.7' },
    getAddress: async () => address,
    encodeCalls: async (calls) =>
      calls.length === 1
        ? encodeFunctionData({
            abi: testAccountAbi,
            functionName: 'execute',
            args: [calls[0]?.to as Address, calls[0]?.value ?? 0n, calls[0]?.data ?? '0x'],
          })
        : encodeFunctionData({
            abi: testAccountAbi,
            functionName: 'executeBatch',
            args: [
              calls.map((call) => ({
                target: call.to,
                value: call.value ?? 0n,
                data: call.data ?? '0x',
              })),
            ],
          }),
    getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
    getStubSignature: async () => SIGNATURE,
    signMessage: async () => SIGNATURE,
    signTypedData: async () => SIGNATURE,
    signUserOperation: async () => SIGNATURE,
  });
}
