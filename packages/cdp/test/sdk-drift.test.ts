import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as chains from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { CDP_NETWORK_CHAIN_IDS } from '../src/index.js';
import { CDP_API_SEND_CHAIN_IDS } from '../src/networks.js';

// Compares the adapter's copies of SDK rules with the installed SDK, which does not export them. The scheduled
// workflow runs this against the newest SDK in the peer range, so that a change there fails here.
const sdkRoot = join(dirname(createRequire(import.meta.url).resolve('@coinbase/cdp-sdk')), '..');
const sdkModule = (path: string) => import(pathToFileURL(join(sdkRoot, '_esm', path)).href);

describe('the installed @coinbase/cdp-sdk', () => {
  it('maps every network name it resolves to a chain the same way as CDP_NETWORK_CHAIN_IDS', async () => {
    const { NETWORK_TO_CHAIN_MAP } = await sdkModule('accounts/evm/networkToChainResolver.js');
    const sdk = Object.fromEntries(
      Object.entries(NETWORK_TO_CHAIN_MAP as Record<string, { id: number }>).map(([n, c]) => [
        n,
        c.id,
      ]),
    );
    expect(sdk).not.toEqual({});
    for (const [network, chainId] of Object.entries(sdk)) {
      expect({ network, chainId: CDP_NETWORK_CHAIN_IDS[network] }).toEqual({ network, chainId });
    }
  });

  it('accepts no network for cdp.evm.sendTransaction that CDP_NETWORK_CHAIN_IDS lacks', async () => {
    const { SendEvmTransactionBodyNetwork } = await sdkModule(
      'openapi-client/generated/coinbaseDeveloperPlatformAPIs.schemas.js',
    );
    const networks = Object.values(SendEvmTransactionBodyNetwork as Record<string, string>);
    expect(networks.length).toBeGreaterThan(0);
    expect(networks.filter((n) => CDP_NETWORK_CHAIN_IDS[n] === undefined)).toEqual([]);
  });

  it('sends network-scoped transactions through its API on the chains of CDP_API_SEND_CHAIN_IDS', async () => {
    const source = await readFile(
      join(sdkRoot, '_esm', 'accounts/evm/toNetworkScopedEvmServerAccount.js'),
      'utf8',
    );
    const rule = /shouldUseApiForSends\s*=([^;]*);/.exec(source)?.[1];
    expect(rule, 'shouldUseApiForSends not found').toBeDefined();
    const names = [...(rule ?? '').matchAll(/chain\.id\s*===\s*(\w+)\.id/g)].map((m) => m[1] ?? '');
    const byName = chains as unknown as Record<string, { id: number } | undefined>;
    const ids = names.map((name) => byName[name]?.id);
    expect(ids).not.toContain(undefined);
    expect(new Set(ids)).toEqual(new Set(CDP_API_SEND_CHAIN_IDS));
  });
});
