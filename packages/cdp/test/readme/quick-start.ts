// Example from packages/cdp/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { Address } from 'viem';

declare const to: Address;
declare const value: bigint;

// #region readme
import { CdpClient } from '@coinbase/cdp-sdk';
import { withHashspan } from '@hashspan/cdp';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const cdp = new CdpClient();
// Wraps the client in place; call it once, right after creating the client.
const hashspan = withHashspan(cdp, {
  reader: createPublicClient({ chain: baseSepolia, transport: http() }),
});

const account = await cdp.evm.getOrCreateAccount({ name: 'treasury' });
await account.sendTransaction({ network: 'base-sepolia', transaction: { to, value } }); // send + confirm spans

// Before a short-lived process exits:
await hashspan.flush();
// #endregion
