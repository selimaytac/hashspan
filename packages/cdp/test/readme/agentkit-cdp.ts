// Example from docs/integrations.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the document shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { CdpClient } from '@coinbase/cdp-sdk';
import type { PublicClient } from 'viem';

// Stands in for `CdpEvmWalletProvider` of @coinbase/agentkit, which this repository does not depend on.
declare const CdpEvmWalletProvider: {
  configureWithWallet(config: object): Promise<{
    getClient(): CdpClient;
    getPublicClient(): PublicClient;
  }>;
};
declare const config: object;

// #region readme
import { withHashspan } from '@hashspan/cdp';

const walletProvider = await CdpEvmWalletProvider.configureWithWallet(config);
// Wraps the provider's CdpClient in place, before its first transaction.
const hashspan = withHashspan(walletProvider.getClient(), {
  reader: walletProvider.getPublicClient(),
});
// #endregion
