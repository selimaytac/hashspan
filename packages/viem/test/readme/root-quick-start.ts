// Example from README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. The README presents it as a complete file.

// #region readme
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318. Start it before the first transaction.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http('http://127.0.0.1:8545');

const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

// Stands in for your agent's tool call: the send and confirm spans become its children.
await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    await reader.waitForTransactionReceipt({ hash });
  } finally {
    span.end();
  }
});

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
// #endregion
