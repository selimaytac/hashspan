import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  pad,
  parseTransaction,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { testAccountAbi, testEntryPointAbi } from '../../viem/test/entry-point/test-entry-point.js';

/** Throwaway credentials in the formats the CDP SDK accepts; generated per test run, never committed. */
export function throwawayCredentials(): {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
} {
  const ed = generateKeyPairSync('ed25519');
  const seed = ed.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    apiKeyId: 'test-key',
    apiKeySecret: Buffer.concat([seed, pub]).toString('base64'),
    walletSecret: ec.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};

/** The fields of a v0.7 packed user operation, as the stand-in EntryPoint takes them. */
interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

/**
 * A local stand-in for the CDP API: accounts are an unlocked Anvil account, and "send transaction" broadcasts the
 * serialized transaction's fields from it on Anvil, as CDP would sign and broadcast on the real network.
 *
 * With `smartAccount`, it also serves the smart account routes: the account is the test smart account deployed at
 * that address, preparing a user operation builds it for the stand-in EntryPoint at the v0.7 address (hash, nonce,
 * `executeBatch` call data), and sending it puts it into its own `handleOps` bundle transaction from `bundler`, as
 * CDP's bundler would. The owner's signature is not checked, as the stand-in EntryPoint does not validate it.
 */
export async function startMockCdpApi(options: {
  rpcUrl: string;
  account: Address;
  smartAccount?: Address | undefined;
  bundler?: Address | undefined;
}): Promise<{
  basePath: string;
  requests: string[];
  /** Makes the next send fail with this CDP API error body, as the real API reports a failed send. */
  failNextSend: (error: { status: number; errorType: string; errorMessage: string }) => void;
  /** Reports the next user operation sent as `failed`, as CDP does for an operation that failed. */
  failNextUserOperation: () => void;
  close: () => Promise<void>;
}> {
  const anvil = createWalletClient({ account: options.account, transport: http(options.rpcUrl) });
  const chain = createPublicClient({ transport: http(options.rpcUrl), pollingInterval: 20 });
  const requests: string[] = [];
  let nextSendError: { status: number; errorType: string; errorMessage: string } | undefined;
  let failUserOperation = false;
  const bundler = options.bundler
    ? createWalletClient({ account: options.bundler, transport: http(options.rpcUrl) })
    : undefined;
  /** Prepared and sent user operations by hash, lower-cased. */
  const operations = new Map<
    string,
    {
      network: string;
      calls: unknown[];
      packed: PackedUserOperation;
      bundle?: Hex;
      failed?: boolean;
    }
  >();
  const operationOf = (hash: string) => {
    const operation = operations.get(hash.toLowerCase());
    if (!operation) throw new Error(`mock: no user operation ${hash}`);
    return operation;
  };
  const userOperationBody = (hash: string) => {
    const { network, calls, bundle, failed } = operationOf(hash);
    const status = failed ? 'failed' : bundle ? 'complete' : 'broadcast';
    return {
      network,
      userOpHash: hash,
      calls,
      status,
      ...(bundle && !failed ? { transactionHash: bundle } : {}),
    };
  };
  const server: Server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    requests.push(`${request.method} ${path}`);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const body = await readJson(request);
      // Network-scoped accounts on Base read through CDP's node: the SDK asks for a token, then calls its RPC URL.
      if (request.method === 'GET' && path === '/apikeys/v1/tokens/active') {
        return reply(200, { id: 'mock-token' });
      }
      if (request.method === 'POST' && /^\/rpc\/v1\/[a-z-]+\/mock-token$/.test(path)) {
        const upstream = await fetch(options.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return reply(upstream.status, await upstream.json());
      }
      if (request.method === 'POST' && path === '/platform/v2/evm/accounts') {
        return reply(201, { address: options.account, name: body.name ?? 'agent' });
      }
      const send = path.match(
        /^\/platform\/v2\/evm\/accounts\/(0x[0-9a-fA-F]{40})\/send\/transaction$/,
      );
      if (request.method === 'POST' && send) {
        if (nextSendError) {
          const { status, ...error } = nextSendError;
          nextSendError = undefined;
          return reply(status, error);
        }
        const tx = parseTransaction(body.transaction as `0x${string}`);
        const transactionHash = await anvil.sendTransaction({
          chain: null,
          to: tx.to ?? null,
          value: tx.value,
          data: tx.data,
        });
        // Answer once the receipt can be read, so that tests do not depend on how fast the node indexes it.
        await chain.waitForTransactionReceipt({ hash: transactionHash });
        return reply(200, { transactionHash });
      }
      const smart = options.smartAccount;
      if (request.method === 'POST' && path === '/platform/v2/evm/smart-accounts' && smart) {
        return reply(201, { address: smart, owners: body.owners, name: body.name ?? 'agent' });
      }
      const sign = path.match(/^\/platform\/v2\/evm\/accounts\/(0x[0-9a-fA-F]{40})\/sign$/);
      if (request.method === 'POST' && sign) {
        return reply(200, { signature: `0x${'11'.repeat(65)}` });
      }
      const prepare = path.match(
        /^\/platform\/v2\/evm\/smart-accounts\/(0x[0-9a-fA-F]{40})\/user-operations$/,
      );
      if (request.method === 'POST' && prepare && smart) {
        const calls = body.calls as { to: Address; data: Hex; value: string }[];
        const nonce = await chain.readContract({
          address: entryPoint07Address,
          abi: testEntryPointAbi,
          functionName: 'getNonce',
          args: [smart, 0n],
        });
        const packed: PackedUserOperation = {
          sender: smart,
          nonce,
          initCode: '0x',
          callData: encodeFunctionData({
            abi: testAccountAbi,
            functionName: 'executeBatch',
            args: [calls.map((c) => ({ target: c.to, value: BigInt(c.value), data: c.data }))],
          }),
          accountGasLimits: pad('0x', { size: 32 }),
          preVerificationGas: 50_000n,
          gasFees: pad('0x', { size: 32 }),
          paymasterAndData: '0x',
          signature: '0x',
        };
        const userOpHash = await chain.readContract({
          address: entryPoint07Address,
          abi: testEntryPointAbi,
          functionName: 'getUserOpHash',
          args: [packed],
        });
        operations.set(userOpHash.toLowerCase(), {
          network: body.network as string,
          calls: body.calls as unknown[],
          packed,
        });
        return reply(201, { ...userOperationBody(userOpHash), status: 'pending' });
      }
      const sendOperation = path.match(
        /^\/platform\/v2\/evm\/smart-accounts\/0x[0-9a-fA-F]{40}\/user-operations\/(0x[0-9a-fA-F]{64})\/send$/,
      );
      if (request.method === 'POST' && sendOperation?.[1] && bundler) {
        const operation = operationOf(sendOperation[1]);
        const bundle = await bundler.writeContract({
          chain: null,
          address: entryPoint07Address,
          abi: testEntryPointAbi,
          functionName: 'handleOps',
          args: [
            [{ ...operation.packed, signature: body.signature as Hex }],
            bundler.account.address,
          ],
          gas: 5_000_000n,
        });
        await chain.waitForTransactionReceipt({ hash: bundle });
        operation.bundle = bundle;
        if (failUserOperation) {
          failUserOperation = false;
          operation.failed = true;
        }
        return reply(200, { ...userOperationBody(sendOperation[1]), status: 'broadcast' });
      }
      const get = path.match(
        /^\/platform\/v2\/evm\/smart-accounts\/0x[0-9a-fA-F]{40}\/user-operations\/(0x[0-9a-fA-F]{64})$/,
      );
      if (request.method === 'GET' && get?.[1]) {
        return reply(200, userOperationBody(get[1]));
      }
      return reply(404, { errorType: 'not_found', errorMessage: `mock: no route for ${path}` });
    } catch (error) {
      return reply(500, { errorType: 'internal', errorMessage: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    basePath: `http://127.0.0.1:${port}/platform`,
    requests,
    failNextSend: (error) => {
      nextSendError = error;
    },
    failNextUserOperation: () => {
      failUserOperation = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
