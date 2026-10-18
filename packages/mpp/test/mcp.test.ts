// Paid MCP tools (ADR 0029, resolved questions): `McpClient.wrap` from mppx/mcp/client pays with the methods it is
// given, not through an `Mppx` client, so its payments reach no client event and are not traced. The MCP client here is a
// stand-in with `callTool`, the one member `wrap()` uses; it answers as an MCP server that asks for payment would.
import { Challenge, Mcp, Receipt } from 'mppx';
import { tempo } from 'mppx/client';
import { McpClient } from 'mppx/mcp/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withHashspan } from '../src/index.js';
import { PAYER, paidApi, paidServer, payerClient, settled, testClient } from './fake-mppx.js';
import { setupTracing, type TestTracing } from './tracing.js';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

it('does not trace a paid MCP tool call through McpClient.wrap, which fires no client event', async () => {
  const challengeResponse = await paidServer()(new Request('https://api.example.com/mcp'));
  const challenge = Challenge.fromResponse(challengeResponse);
  const credentials: unknown[] = [];
  const mcp = {
    async callTool(params: { name: string; _meta?: Record<string, unknown> }) {
      const credential = params._meta?.[Mcp.credentialMetaKey];
      if (!credential) {
        throw Object.assign(new Error('Payment Required'), {
          code: Mcp.paymentRequiredCode,
          data: { challenges: [challenge] },
        });
      }
      credentials.push(credential);
      return {
        content: [{ type: 'text', text: 'sunny' }],
        _meta: {
          [Mcp.receiptMetaKey]: Receipt.from({
            method: 'tempo',
            reference: `0x${'ab'.repeat(32)}`,
            status: 'success',
            timestamp: new Date().toISOString(),
          } as never),
        },
      };
    },
  };
  // The same Tempo method on an Mppx client that hashspan traces, and in the MCP wrapper.
  const method = tempo({ account: PAYER, mode: 'pull', getClient: () => payerClient() as never });
  const client = testClient(paidApi(settled()).fetch);
  const events = vi.fn();
  client.on('*', events);
  const hashspan = withHashspan(client);
  McpClient.wrap(mcp as never, { methods: [method] });

  const result = (await (mcp.callTool as (params: unknown) => Promise<{ receipt?: unknown }>)({
    name: 'weather',
    arguments: {},
  })) as { receipt?: { reference?: string } };
  expect(credentials).toHaveLength(1);
  expect(result.receipt?.reference).toBe(`0x${'ab'.repeat(32)}`);
  expect(await hashspan.flush()).toBe(true);
  expect(events).not.toHaveBeenCalled();
  expect(tracing.spans()).toEqual([]);
});
