// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written against eRPC in front of Anvil
// (erpc.int.test.ts), and docs.test.ts checks that the docs show the region unchanged. The docs show the region as
// the lines that differ from erpc-agent.ts, the agent with the undici instrumentation.
import { propagateTraceContext, traceTransport, withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// #region readme
// No HTTP instrumentation: the hook sends the `traceparent` header of each JSON-RPC span.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

const transport = traceTransport(
  http(process.env.RPC_URL ?? 'http://127.0.0.1:4000/main/evm/31337', {
    onFetchRequest: propagateTraceContext(),
  }),
);
// #endregion
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    console.log(`${hash} ${receipt.status}`);
  } finally {
    span.end();
  }
});

await hashspan.flush();
await sdk.shutdown();
