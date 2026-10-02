import { OpenTelemetry } from '@ai-sdk/otel';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerTelemetry } from 'ai';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, expect, it } from 'vitest';

// A local chain that reports Base Sepolia's chain id stands in for the testnet: tests never leave localhost.
const PORT = 18556;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: 84532,
});
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const rpc = createPublicClient({ transport: http(RPC_URL) });

/** A fresh account holding `eth`, so no key is ever written down. */
async function fundedKey(eth: string) {
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  await rpc.request({
    method: 'anvil_setBalance' as never,
    params: [address, numberToHex(parseEther(eth))] as never,
  });
  return { privateKey, address };
}

beforeAll(async () => {
  await instance.start();
  provider.register();
  registerTelemetry(new OpenTelemetry());
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  await instance.stop();
});

it('runs the agent with a private key and a deployed vault', async () => {
  const { privateKey, address } = await fundedKey('0.001');
  const { baseSepoliaChain } = await import('../src/base-sepolia.js');
  const { runDemo } = await import('../src/demo.js');
  const lines: string[] = [];

  const chain = await baseSepoliaChain(
    { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: RPC_URL },
    (line) => lines.push(line),
  );
  expect(chain.vendor).toBe(address);
  expect(lines.join('\n')).not.toContain(privateKey.slice(2));
  const { toolResults } = await runDemo(chain);
  expect(toolResults.map((r) => (r.output as { status: string }).status)).toEqual([
    'success',
    'reverted',
  ]);

  const spans = exporter.getFinishedSpans();
  // The vault deployment is setup, not the agent's work: only the two tool transactions are traced.
  expect(spans.filter((s) => s.name === 'send 84532')).toHaveLength(2);
  const confirms = spans.filter((s) => s.name === 'confirm 84532');
  expect(confirms).toHaveLength(2);
  const withdrawal = confirms.find((s) => s.attributes['blockchain.tx.status'] === 'reverted');
  expect(withdrawal?.attributes['blockchain.tx.revert.reason']).toBe(
    'WithdrawalLimitExceeded(10000000000000, 20000000000000)',
  );
});

it('stops before sending anything when the balance does not cover the run', async () => {
  const { privateKey, address } = await fundedKey('0.000001');
  const { baseSepoliaChain } = await import('../src/base-sepolia.js');
  const before = await rpc.getTransactionCount({ address });

  await expect(
    baseSepoliaChain(
      { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: RPC_URL },
      () => {},
    ),
  ).rejects.toThrow(`fund ${address} from a Base Sepolia faucet`);
  expect(await rpc.getTransactionCount({ address })).toBe(before);
});
