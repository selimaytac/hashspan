// Example from packages/cdp/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { CdpClient } from '@coinbase/cdp-sdk';
import { withHashspan } from '@hashspan/cdp';
import { type Address, createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

declare const to: Address;
declare const value: bigint;

const cdp = new CdpClient();
const hashspan = withHashspan(cdp, {
  reader: createPublicClient({ chain: baseSepolia, transport: http() }),
});

// #region readme
const owner = await cdp.evm.getOrCreateAccount({ name: 'owner' });
const smartAccount = await cdp.evm.getOrCreateSmartAccount({ name: 'treasury', owner });

const { userOpHash } = await smartAccount.sendUserOperation({
  network: 'base-sepolia',
  calls: [{ to, value, data: '0x' }],
}); // send span
await smartAccount.waitForUserOperation({ userOpHash }); // confirm span
// #endregion

await hashspan.flush();
