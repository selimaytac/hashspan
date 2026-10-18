// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written, as the stdio child process that
// readme/mcp-client.ts starts (mcp.int.test.ts), and docs.test.ts checks that the docs show the region unchanged.
// The docs present it as a complete file.

// #region readme
import { withHashspan } from '@hashspan/viem';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { context, propagation } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { z } from 'zod';

// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise. Never log to
// stdout: it carries the MCP messages.
const sdk = new NodeSDK({ serviceName: 'wallet-mcp' });
sdk.start();

const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http(process.env.RPC_URL ?? 'http://127.0.0.1:8545'); // Anvil
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

/** Runs `fn` in the trace context the client sent in the request's `_meta`. */
function inClientTrace<T>(ctx: ServerContext, fn: () => Promise<T>): Promise<T> {
  return context.with(propagation.extract(context.active(), ctx.mcpReq._meta ?? {}), fn);
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'wallet', version: '1.0.0' });
  server.registerTool(
    'pay_vendor',
    { description: 'Pays the vendor an amount of ETH.', inputSchema: z.object({ amountEth: z.string() }) },
    ({ amountEth }, ctx) =>
      inClientTrace(ctx, async () => {
        const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
        const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
        const receipt = await reader.waitForTransactionReceipt({ hash });
        return { content: [{ type: 'text', text: `${hash} ${receipt.status}` }] };
      }),
  );
  return server;
}

serveStdio(createServer);

// The client ends stdin to stop the server: export the pending spans before the process exits.
process.stdin.once('end', async () => {
  await hashspan.flush();
  await sdk.shutdown();
  process.exit(0);
});
// #endregion
