// Example from packages/x402/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { Hex } from 'viem';

declare const privateKey: Hex;

// #region readme
import { withHashspan } from '@hashspan/x402';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(privateKey) });
// Registers hooks on the client; call it once per client.
const hashspan = withHashspan(client, {
  reader: createPublicClient({ chain: baseSepolia, transport: http() }),
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
await fetchWithPayment('https://api.example.com/weather'); // payment span, then confirm span

// Before a short-lived process exits:
await hashspan.flush();
// #endregion
