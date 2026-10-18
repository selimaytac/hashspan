// The MCP server of mcp.int.test.ts with the v1 SDK (@modelcontextprotocol/sdk), as a stdio child process of
// mcp-v1/client.ts. Its tool sends on Anvil with a traced wallet client; with MCP_PROPAGATION=openinference it runs
// the OpenInference setup of docs/integrations.md (readme/mcp-instrumentation.ts) first, without it nothing carries
// the client's trace context. Spans go over OTLP to the test's receiver; stdout carries the MCP messages only.
import { withHashspan } from '@hashspan/viem';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { z } from 'zod';

const sdk = new NodeSDK({ serviceName: 'wallet-mcp' });
sdk.start();
if (process.env.MCP_PROPAGATION === 'openinference')
  await import('../readme/mcp-instrumentation.js');

const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http(process.env.RPC_URL);
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

const server = new McpServer({ name: 'wallet', version: '1.0.0' });
server.registerTool(
  'pay_vendor',
  { description: 'Pays the vendor an amount of ETH.', inputSchema: { amountEth: z.string() } },
  async ({ amountEth }) => {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    return { content: [{ type: 'text', text: `${hash} ${receipt.status}` }] };
  },
);
await server.connect(new StdioServerTransport());

// The v1 stdio server transport does not close on the end of stdin: export the pending spans, then exit.
process.stdin.once('end', async () => {
  await hashspan.flush();
  await sdk.shutdown();
  process.exit(0);
});
