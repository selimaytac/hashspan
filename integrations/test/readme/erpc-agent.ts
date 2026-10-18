// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file and runs it as written against eRPC in front of Anvil
// (erpc.int.test.ts), and docs.test.ts checks that the docs show the region unchanged. The docs present it as a
// complete file.

// #region readme
import { traceTransport, withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise. The undici
// instrumentation traces each request of Node.js's fetch, which viem's http() transport uses, and sends the
// `traceparent` header that puts eRPC's spans in this trace.
const sdk = new NodeSDK({ serviceName: 'my-agent', instrumentations: [new UndiciInstrumentation()] });
sdk.start();

const account = mnemonicToAccount('test test test test test test test test test test test junk');
// eRPC's project `main` and its network `evm` 31337 in erpc.yaml.
const transport = traceTransport(http(process.env.RPC_URL ?? 'http://127.0.0.1:4000/main/evm/31337'));
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
// #endregion
