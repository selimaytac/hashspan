// The actions a smart account SDK adds to a bundler client, as permissionless.js 0.4 and 0.5 (`smartAccountActions`,
// which `createSmartAccountClient` applies) and ZeroDev 5.5 (`kernelAccountClientActions`) define them: each closes
// over the client it extends and reaches `sendUserOperation` and `waitForUserOperationReceipt` with `getAction` on
// that client, so an extension applied afterwards never sees them (#430). Built with viem only, so the packages/viem
// tests need neither SDK; integrations/test/smart-account-sdks.int.test.ts runs the SDKs themselves.
import { type Abi, type Client, encodeFunctionData, type Hex } from 'viem';
import { sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction';
import { getAction } from 'viem/utils';

// biome-ignore lint/suspicious/noExplicitAny: the SDKs' actions take viem's parameters, which the tests vary.
type Args = any;

/** permissionless's `sendTransaction`: one call as a user operation, then the bundle transaction's hash. */
async function sendTransaction(client: Client, args: Args): Promise<Hex> {
  const {
    account = client.account,
    data,
    maxFeePerGas,
    maxPriorityFeePerGas,
    to,
    value,
    nonce,
  } = args;
  const userOpHash = await getAction(
    client,
    sendUserOperation,
    'sendUserOperation',
  )({
    ...args,
    calls: [{ to, value: value || 0n, data: data || '0x' }],
    account,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce: nonce ? BigInt(nonce) : undefined,
  });
  const receipt = await getAction(
    client,
    waitForUserOperationReceipt,
    'waitForUserOperationReceipt',
  )({ hash: userOpHash });
  return receipt.receipt.transactionHash;
}

/** The actions of a smart account SDK, closed over `client`. */
export function sdkSmartAccountActions(client: Client) {
  return {
    sendTransaction: (args: Args): Promise<Hex> => sendTransaction(client, args),
    writeContract: ({
      abi,
      address,
      args,
      functionName,
      ...request
    }: Args & { abi: Abi; address: Hex; functionName: string }): Promise<Hex> =>
      sendTransaction(client, {
        data: encodeFunctionData({ abi, args, functionName }),
        to: address,
        ...request,
      }),
    // permissionless's `sendCalls`: the batch id is the user operation hash.
    sendCalls: async (args: Args): Promise<{ id: Hex }> => ({
      id: await getAction(client, sendUserOperation, 'sendUserOperation')({ ...args }),
    }),
  };
}
