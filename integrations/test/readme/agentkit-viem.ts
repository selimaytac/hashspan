// Example from docs/integrations.md.
// `pnpm test:integrations` compiles this file against @coinbase/agentkit's types, and docs.test.ts checks that the
// docs show the region unchanged. integrations/test/agentkit-viem.int.test.ts runs the same setup against Anvil.

// #region readme
import { ViemWalletProvider } from '@coinbase/agentkit';
import { withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Start the OpenTelemetry SDK before this, as in the quick start.
const rpcUrl = 'http://127.0.0.1:8545'; // Anvil
const account = mnemonicToAccount('test test test test test test test test test test test junk');

// The provider waits for receipts on a client of its own: background confirmation records them.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const walletClient = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) }).extend(
  hashspan,
);
const walletProvider = new ViemWalletProvider(
  // AgentKit pins its own viem: see below.
  walletClient as unknown as ConstructorParameters<typeof ViemWalletProvider>[0],
  { rpcUrl },
);

await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    // The amount in wei, as a decimal string.
    await walletProvider.nativeTransfer(
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      parseEther('0.01').toString(),
    );
  } finally {
    span.end();
  }
});

// Before a short-lived process exits, then shut the SDK down:
await hashspan.flush();
// #endregion
