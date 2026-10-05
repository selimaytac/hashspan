// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it against Anvil (mastra-agent.int.test.ts), and
// docs.test.ts checks that the docs show the region unchanged. The docs present it as a complete file.

// #region readme
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';
import { OtelBridge } from '@mastra/otel-bridge';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { MockLanguageModelV4 } from 'ai/test';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { z } from 'zod';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318. Start it before the agent runs a tool.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http('http://127.0.0.1:8545');
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

const payVendor = createTool({
  id: 'pay_vendor',
  description: 'Pays the vendor an amount of ETH.',
  inputSchema: z.object({ amountEth: z.string() }),
  execute: async ({ amountEth }) => {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  },
});

// A scripted model instead of a provider, so no API key is needed: it calls the tool once, then answers.
const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const model = new MockLanguageModelV4({
  doGenerate: [
    {
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'pay_vendor', input: '{"amountEth":"0.01"}' }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'Paid the vendor 0.01 ETH.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  ],
});

const agent = new Agent({
  id: 'treasury',
  name: 'treasury',
  instructions: 'Pay vendors when asked.',
  model,
  tools: { pay_vendor: payVendor },
});
// The bridge runs each tool inside its execute_tool span, so the send and confirm spans become its children.
new Mastra({
  agents: { treasury: agent },
  observability: new Observability({
    configs: { default: { serviceName: 'my-agent', bridge: new OtelBridge() } },
  }),
});

const result = await agent.generate('Pay the vendor 0.01 ETH.');
console.log(result.text);

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
// #endregion
