// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written, as a child process (genkit.int.test.ts), and
// docs.test.ts checks that the docs show the region unchanged. The docs present it as a complete file.

// #region readme
import { withHashspan } from '@hashspan/viem';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { genkit, z } from 'genkit';
import { disableGenkitOTelInitialization } from 'genkit/tracing';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Genkit starts an OpenTelemetry SDK of its own on its first span unless told not to: this process has one.
disableGenkitOTelInitialization();
// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise. Start it before
// Genkit runs anything.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http(process.env.RPC_URL ?? 'http://127.0.0.1:8545'); // Anvil
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

const ai = genkit({});

// Genkit runs the tool's function inside the tool's span, so the send and confirm spans become its children.
const payVendor = ai.defineTool(
  {
    name: 'pay_vendor',
    description: 'Pays the vendor an amount of ETH.',
    inputSchema: z.object({ amountEth: z.string() }),
    outputSchema: z.object({ hash: z.string(), status: z.string() }),
  },
  async ({ amountEth }) => {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  },
);

// A scripted model instead of a provider plugin, so no API key is needed: it asks for the tool once, then answers.
ai.defineModel({ name: 'scripted' }, async (request) => {
  const paid = request.messages.some((message) => message.content.some((part) => part.toolResponse));
  return {
    message: {
      role: 'model',
      content: paid
        ? [{ text: 'Paid the vendor 0.01 ETH.' }]
        : [{ toolRequest: { name: 'pay_vendor', ref: 'call_1', input: { amountEth: '0.01' } } }],
    },
    finishReason: 'stop',
  };
});

const { text } = await ai.generate({
  model: 'scripted',
  prompt: 'Pay the vendor 0.01 ETH.',
  tools: [payVendor],
});
console.log(text);

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
// #endregion
