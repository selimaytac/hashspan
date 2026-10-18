// The Genkit agent of readme/genkit-agent.ts, changed by GENKIT_SETUP to check the other setups of the Genkit section
// of docs/integrations.md (genkit.int.test.ts runs it as a child process, since Genkit's settings and OpenTelemetry's
// global registrations last for the process):
// - `default`: without `disableGenkitOTelInitialization()`, so Genkit starts its own OpenTelemetry SDK on its first
//   span, after this one;
// - `genkit-first`: the same, but Genkit runs a step before this process starts its SDK;
// - `request-span`: `generate` inside an active span of this process (`handle_request`), as a server span would be;
// - `request-span-joined`: the same, with `disableOTelRootSpanDetection()`.
// It prints the transaction's hash and status, then the model's answer.
import { withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { genkit, z } from 'genkit';
import { disableGenkitOTelInitialization, disableOTelRootSpanDetection } from 'genkit/tracing';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const setup = process.env.GENKIT_SETUP;
if (
  setup !== 'default' &&
  setup !== 'genkit-first' &&
  setup !== 'request-span' &&
  setup !== 'request-span-joined'
)
  throw new Error(`unknown GENKIT_SETUP ${setup}`);

if (setup === 'request-span' || setup === 'request-span-joined') disableGenkitOTelInitialization();
if (setup === 'request-span-joined') disableOTelRootSpanDetection();
const sdk = new NodeSDK({ serviceName: 'my-agent' });
if (setup !== 'genkit-first') sdk.start();

const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http(process.env.RPC_URL);
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

const ai = genkit({});

const payVendor = ai.defineTool(
  {
    name: 'pay_vendor',
    description: 'Pays the vendor an amount of ETH.',
    inputSchema: z.object({ amountEth: z.string() }),
    outputSchema: z.object({ hash: z.string(), status: z.string() }),
  },
  async ({ amountEth }) => {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    console.log(`${hash} ${receipt.status}`);
    return { hash, status: receipt.status };
  },
);

ai.defineModel({ name: 'scripted' }, async (request) => {
  const paid = request.messages.some((message) =>
    message.content.some((part) => part.toolResponse),
  );
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

if (setup === 'genkit-first') {
  // Genkit's first span starts its SDK, which registers the global tracer provider; this SDK starts too late.
  await ai.run('warm_up', async () => 'ready');
  sdk.start();
}

const generate = () =>
  ai.generate({ model: 'scripted', prompt: 'Pay the vendor 0.01 ETH.', tools: [payVendor] });
const { text } =
  setup === 'request-span' || setup === 'request-span-joined'
    ? await trace.getTracer('my-agent').startActiveSpan('handle_request', async (span) => {
        try {
          return await generate();
        } finally {
          span.end();
        }
      })
    : await generate();
console.log(text);

await hashspan.flush();
await sdk.shutdown();
