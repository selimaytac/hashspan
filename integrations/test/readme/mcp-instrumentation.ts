// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written in the client and the server process of
// mcp.int.test.ts (mcp-v1/client.ts and mcp-v1/server.ts import it), and docs.test.ts checks that the docs show the
// region unchanged.

// #region readme
import { MCPInstrumentation } from '@arizeai/openinference-instrumentation-mcp';
import * as clientStdioModule from '@modelcontextprotocol/sdk/client/stdio.js';
import * as serverStdioModule from '@modelcontextprotocol/sdk/server/stdio.js';

// In the agent's process and in the server's, after the OpenTelemetry SDK starts and before the transport
// connects: the client's requests carry the active trace context in `_meta`, and the server handles each request
// in that context.
new MCPInstrumentation().manuallyInstrument({ clientStdioModule, serverStdioModule });
// #endregion
