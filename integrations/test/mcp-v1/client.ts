// The agent of mcp.int.test.ts with the v1 SDK (@modelcontextprotocol/sdk): it starts mcp-v1/server.ts as a stdio
// child process and calls its tool inside an active span. With MCP_PROPAGATION=openinference it runs the
// OpenInference setup of docs/integrations.md (readme/mcp-instrumentation.ts) first.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();
if (process.env.MCP_PROPAGATION === 'openinference')
  await import('../readme/mcp-instrumentation.js');

// The stdio transport passes only a few variables to the server by default.
const settings = Object.entries(process.env).filter(
  (entry): entry is [string, string] =>
    (entry[0].startsWith('OTEL_') || entry[0] === 'RPC_URL' || entry[0] === 'MCP_PROPAGATION') &&
    entry[1] !== undefined,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [...process.execArgv, new URL('./server.ts', import.meta.url).pathname],
  env: { ...getDefaultEnvironment(), ...Object.fromEntries(settings) },
});
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const result = await client.callTool({ name: 'pay_vendor', arguments: { amountEth: '0.01' } });
    console.log(result.content);
  } finally {
    span.end();
  }
});

await client.close();
await sdk.shutdown();
