// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { Address } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';

declare const account: SmartAccount;
declare const bundlerUrl: string;
declare const to: Address;
declare const value: bigint;

// #region readme
import { createPublicClient, http } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const client = createPublicClient({ chain: baseSepolia, transport: http() });
const bundler = createBundlerClient({ account, client, transport: http(bundlerUrl) }).extend(
  withHashspan(),
);

const hash = await bundler.sendUserOperation({ calls: [{ to, value }] }); // send span
await bundler.waitForUserOperationReceipt({ hash }); // confirm span, linked to the send span
// #endregion
