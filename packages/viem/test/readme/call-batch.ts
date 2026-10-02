// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { Address, EIP1193Provider } from 'viem';

declare const provider: EIP1193Provider;
declare const account: Address;
declare const to: Address;
declare const value: bigint;

// #region readme
import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const wallet = createWalletClient({ account, chain: base, transport: custom(provider) }).extend(
  withHashspan(),
);

const { id } = await wallet.sendCalls({ calls: [{ to, value }] }); // send span
await wallet.waitForCallsStatus({ id }); // confirm span, linked to the send span
// #endregion
