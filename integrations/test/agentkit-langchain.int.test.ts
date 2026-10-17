// The AgentKit OpenTelemetry setup, run against Anvil: AgentKit's `walletActionProvider()` as LangChain tools
// (`getLangChainTools`), a LangChain agent whose middleware wraps each tool call in an `execute_tool` span, and a
// `ViemWalletProvider` over a wallet client extended with `withHashspan({ confirm: { mode: 'background' } })`.
// A scripted chat model calls `native_transfer` once. Nothing leaves localhost (see offline.ts, a setup file).
import { AgentKit, ViemWalletProvider, walletActionProvider } from '@coinbase/agentkit';
import { getLangChainTools } from '@coinbase/agentkit-langchain';
import { withHashspan } from '@hashspan/viem';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { createAgent, createMiddleware } from 'langchain';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry as chain } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAnvil } from '../../packages/viem/test/start-anvil.js';
import { offline } from './offline.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc';
const TOOL = 'WalletActionProvider_native_transfer';
type ProviderClient = ConstructorParameters<typeof ViemWalletProvider>[0];

/** A chat model that answers with the next message of a script: here, one tool call and a final answer. */
class ScriptedChatModel extends BaseChatModel {
  private turn = 0;

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  /** Ignores the tools: the script names them. */
  bindTools(): this {
    return this;
  }

  async _generate(_: BaseMessage[]): Promise<ChatResult> {
    const message = this.script[Math.min(this.turn++, this.script.length - 1)] as AIMessage;
    return { generations: [{ message, text: String(message.content) }] };
  }
}

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: chain.id,
});
const exporter = new tracing.InMemorySpanExporter();
// The setup's instrumentation: a tracer provider with a batch processor. Registering it also installs the context
// manager that makes the spans started in a tool call children of the tool span.
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.BatchSpanProcessor(exporter)],
});

beforeAll(() => provider.register());

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  await instance.stop();
});

const tracer = trace.getTracer('agentkit-opentelemetry-chatbot');

/** Wraps each tool call in an `execute_tool` span, so the transactions a tool sends are recorded under it. */
const toolTracingMiddleware = createMiddleware({
  name: 'ToolTracingMiddleware',
  wrapToolCall: (request, handler) =>
    tracer.startActiveSpan(
      `execute_tool ${request.toolCall.name}`,
      {
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': request.toolCall.name,
          ...(request.toolCall.id ? { 'gen_ai.tool.call.id': request.toolCall.id } : {}),
        },
      },
      async (span) => {
        try {
          return await handler(request);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    ),
});

describe('AgentKit with a LangChain agent', () => {
  it('records the transaction of a tool call under the tool call span', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await createPublicClient({ chain, transport: http(RPC_URL) }).request({
      method: 'anvil_setBalance' as never,
      params: [account.address, `0x${parseEther('10').toString(16)}`] as never,
    });
    const hashspan = withHashspan({ confirm: { mode: 'background' } });
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) }).extend(
      hashspan,
    );
    // AgentKit depends on an exact, older viem whose client type a newer viem's client does not satisfy; at
    // runtime the client works as it is.
    const walletProvider = new ViemWalletProvider(walletClient as unknown as ProviderClient, {
      rpcUrl: RPC_URL,
    });
    const agentkit = await AgentKit.from({
      walletProvider,
      actionProviders: [walletActionProvider()],
    });
    const tools = await getLangChainTools(agentkit);
    expect(tools.map((tool) => tool.name)).toContain(TOOL);

    const model = new ScriptedChatModel([
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: TOOL, args: { to: RECIPIENT, value: '0.01' } }],
      }),
      new AIMessage('Sent 0.01 ETH.'),
    ]);
    const agent = createAgent({
      model,
      // @coinbase/agentkit-langchain 0.3.0 builds its tools with @langchain/core 0.3, whose tool type langchain 1
      // does not accept; at runtime they work as they are.
      tools: tools as unknown as NonNullable<Parameters<typeof createAgent>[0]['tools']>[number][],
      checkpointer: new MemorySaver(),
      middleware: [toolTracingMiddleware],
    });
    const result = await agent.invoke(
      { messages: [new HumanMessage(`Send 0.01 ETH to ${RECIPIENT}`)] },
      { configurable: { thread_id: 'agentkit-langchain' } },
    );

    const toolMessage = result.messages.find((message: BaseMessage) => message.type === 'tool');
    const output = String(toolMessage?.content);
    const hash = output.match(/0x[0-9a-fA-F]{64}/)?.[0];
    expect(hash, output).toBeDefined();
    const reader = createPublicClient({ chain, transport: http(RPC_URL) });
    expect(await reader.getBalance({ address: RECIPIENT })).toBe(parseEther('0.01'));

    await hashspan.flush();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const names = JSON.stringify(spans.map((span) => span.name));
    const toolSpan = spans.find((span) => span.name === `execute_tool ${TOOL}`);
    const send = spans.find((span) => span.name === `send ${chain.id}`);
    const confirm = spans.find((span) => span.name === `confirm ${chain.id}`);
    expect(toolSpan, names).toBeDefined();
    expect(send, names).toBeDefined();
    expect(confirm, names).toBeDefined();
    for (const span of [send, confirm]) {
      expect(span?.spanContext().traceId).toBe(toolSpan?.spanContext().traceId);
      expect(span?.parentSpanContext?.spanId).toBe(toolSpan?.spanContext().spanId);
      expect(span?.attributes['blockchain.tx.hash']).toBe(hash);
    }
    expect(confirm?.attributes['blockchain.tx.status']).toBe('success');
    expect(offline.unexpected).toEqual([]);
  });
});
