// The control of erpc.int.test.ts: readme/erpc-agent.ts without the undici instrumentation, so no request to eRPC
// carries a `traceparent` header.
import { traceTransport, withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = traceTransport(http(process.env.RPC_URL));
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    console.log(`${hash} ${receipt.status}`);
  } finally {
    span.end();
  }
});

await hashspan.flush();
await sdk.shutdown();
