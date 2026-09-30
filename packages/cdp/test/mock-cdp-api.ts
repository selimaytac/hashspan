import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type Address, createPublicClient, createWalletClient, http, parseTransaction } from 'viem';

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

/**
 * A local stand-in for the CDP API: accounts are an unlocked Anvil account, and "send transaction" broadcasts the
 * serialized transaction's fields from it on Anvil, as CDP would sign and broadcast on the real network.
 */
export async function startMockCdpApi(options: { rpcUrl: string; account: Address }): Promise<{
  basePath: string;
  requests: string[];
  /** Makes the next send fail with this CDP API error body, as the real API reports a failed send. */
  failNextSend: (error: { status: number; errorType: string; errorMessage: string }) => void;
  close: () => Promise<void>;
}> {
  const anvil = createWalletClient({ account: options.account, transport: http(options.rpcUrl) });
  const chain = createPublicClient({ transport: http(options.rpcUrl), pollingInterval: 20 });
  const requests: string[] = [];
  let nextSendError: { status: number; errorType: string; errorMessage: string } | undefined;
  const server: Server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    requests.push(`${request.method} ${path}`);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const body = await readJson(request);
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
