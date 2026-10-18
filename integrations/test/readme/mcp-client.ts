// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written against Anvil (mcp.int.test.ts), and
// docs.test.ts checks that the docs show the region unchanged. The docs present it as a complete file.

// #region readme
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

/** The active trace context as `_meta` keys (`traceparent`, `tracestate`, `baggage`) for one request. */
function traceMeta(): Record<string, string> {
  const meta: Record<string, string> = {};
  propagation.inject(context.active(), meta);
  return meta;
}

// A stdio server gets only a few variables of this environment, such as PATH and HOME: pass on its
// OpenTelemetry and RPC settings. It runs mcp-server.ts next to this file, with this process's Node.js flags (tsx's).
const settings = Object.entries(process.env).filter(
  (entry): entry is [string, string] =>
    (entry[0].startsWith('OTEL_') || entry[0] === 'RPC_URL') && entry[1] !== undefined,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [...process.execArgv, new URL('./mcp-server.ts', import.meta.url).pathname],
  env: { ...getDefaultEnvironment(), ...Object.fromEntries(settings) },
});
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

// The agent's tool call: the server's send and confirm spans become children of this span.
await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const result = await client.callTool({
      name: 'pay_vendor',
      arguments: { amountEth: '0.01' },
      _meta: traceMeta(),
    });
    console.log(result.content);
  } finally {
    span.end();
  }
});

// Closing ends the server's stdin, so it exports its spans and exits; then this process's spans.
await client.close();
await sdk.shutdown();
// #endregion
