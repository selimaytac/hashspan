import { createServer, type Server } from 'node:http';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { baseSepoliaChain, DemoSetupError, readBaseSepoliaEnv } from '../src/base-sepolia.js';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A JSON-RPC endpoint that reports `chainId` and records every method it is asked for. */
async function rpcReporting(chainId: number): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      methods.push(method);
      const result = method === 'eth_chainId' ? `0x${chainId.toString(16)}` : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, methods };
}

describe('readBaseSepoliaEnv', () => {
  it('reads the key and the RPC URL, with the public endpoint as default', () => {
    const key = generatePrivateKey();
    expect(readBaseSepoliaEnv({ BASE_SEPOLIA_PRIVATE_KEY: key })).toEqual({
      privateKey: key,
      rpcUrl: 'https://sepolia.base.org',
    });
    expect(
      readBaseSepoliaEnv({
        BASE_SEPOLIA_PRIVATE_KEY: key,
        BASE_SEPOLIA_RPC_URL: 'https://rpc.example',
      }).rpcUrl,
    ).toBe('https://rpc.example');
  });

  it('says which variable is missing', () => {
    expect(() => readBaseSepoliaEnv({})).toThrow(
      new DemoSetupError('BASE_SEPOLIA_PRIVATE_KEY is not set.'),
    );
  });

  it('rejects a malformed key without repeating it', () => {
    // A key with one character too many: the error must not leak any of it.
    const malformed = `${generatePrivateKey()}a`;
    let message = '';
    try {
      readBaseSepoliaEnv({ BASE_SEPOLIA_PRIVATE_KEY: malformed });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('BASE_SEPOLIA_PRIVATE_KEY must be 0x followed by 64 hex characters.');
    expect(
      readBaseSepoliaEnv.bind(null, { BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey().slice(2) }),
    ).toThrow(DemoSetupError);
  });

  it('rejects an RPC URL that is not http or https, without repeating it', () => {
    const key = generatePrivateKey();
    expect(() =>
      readBaseSepoliaEnv({
        BASE_SEPOLIA_PRIVATE_KEY: key,
        BASE_SEPOLIA_RPC_URL: 'not a url secret',
      }),
    ).toThrow(new DemoSetupError('BASE_SEPOLIA_RPC_URL is not a valid URL.'));
    expect(() =>
      readBaseSepoliaEnv({
        BASE_SEPOLIA_PRIVATE_KEY: key,
        BASE_SEPOLIA_RPC_URL: 'ws://rpc.example/secret',
      }),
    ).toThrow(new DemoSetupError('BASE_SEPOLIA_RPC_URL must be an http or https URL.'));
  });
});

describe('baseSepoliaChain', () => {
  it('refuses any other chain before reading the account or sending anything', async () => {
    const rpc = await rpcReporting(31337);
    await expect(
      baseSepoliaChain(
        { BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: rpc.url },
        () => {},
      ),
    ).rejects.toThrow(
      new DemoSetupError(
        'The RPC reports chain id 31337; this demo only runs on Base Sepolia (84532).',
      ),
    );
    expect(rpc.methods).toEqual(['eth_chainId']);
  });
});
