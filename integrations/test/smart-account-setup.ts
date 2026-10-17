// The reader's own values in readme/permissionless.ts: a smart account and a bundler URL. The account is a stand-in
// account on the stand-in EntryPoint (packages/viem/test/test-smart-account.ts) instead of `toSimpleSmartAccount` or
// another permissionless account, whose factory and EntryPoint contracts are not available under the workspace's
// license check (docs/adr/0021, Implementation notes); smart-account-sdks.int.test.ts installs both on Anvil and
// answers the bundler URL with packages/viem/test/test-bundler.ts.
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { testSmartAccount } from '../../packages/viem/test/test-smart-account.js';

export const ANVIL_URL = 'http://127.0.0.1:8545';
export const bundlerUrl = 'http://127.0.0.1:4337';
export const SMART_ACCOUNT = '0x00000000000000000000000000000000000A11cE' as const;

export const account = await testSmartAccount(
  createPublicClient({ chain: foundry, transport: http(ANVIL_URL) }),
  SMART_ACCOUNT,
);
