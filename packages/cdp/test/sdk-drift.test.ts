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

  it.each(['EvmUserOperationNetwork', 'SpendPermissionNetwork'])(
    'accepts no user operation network (%s) that CDP_NETWORK_CHAIN_IDS lacks',
    async (name) => {
      const schemas = await sdkModule(
        'openapi-client/generated/coinbaseDeveloperPlatformAPIs.schemas.js',
      );
      const networks = Object.values(schemas[name] as Record<string, string>);
      expect(networks.length).toBeGreaterThan(0);
      expect(networks.filter((n) => CDP_NETWORK_CHAIN_IDS[n] === undefined)).toEqual([]);
    },
  );

  it('gives up waiting for a user operation with an error named TimeoutError', async () => {
    const { waitForUserOperation } = await sdkModule('actions/evm/waitForUserOperation.js');
    const pending = { getUserOperation: async () => ({ status: 'dropped', userOpHash: '0x' }) };
    await expect(
      waitForUserOperation(pending, {
        userOpHash: '0x',
        smartAccountAddress: '0x',
        waitOptions: { timeoutSeconds: 0.05, intervalSeconds: 0.01 },
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('reports a user operation as complete with its transaction hash, or failed', async () => {
    const { waitForUserOperation } = await sdkModule('actions/evm/waitForUserOperation.js');
    const answering = (operation: object) => ({ getUserOperation: async () => operation });
    const options = { userOpHash: '0x01', smartAccountAddress: '0x02' };
    await expect(
      waitForUserOperation(
        answering({ status: 'complete', transactionHash: '0x03', userOpHash: '0x01' }),
        options,
      ),
    ).resolves.toEqual({
      smartAccountAddress: '0x02',
      status: 'complete',
      transactionHash: '0x03',
      userOpHash: '0x01',
    });
    await expect(
      waitForUserOperation(answering({ status: 'failed', userOpHash: '0x01' }), options),
    ).resolves.toEqual({ smartAccountAddress: '0x02', status: 'failed', userOpHash: '0x01' });
  });

  it("sends a smart account's user operations without going through another traced method", async () => {
    const read = (path: string) => readFile(join(sdkRoot, '_esm', path), 'utf8');
    // Each send method calls the SDK's functions, so the adapter wraps each and traces each once ...
    for (const path of [
      'accounts/evm/toEvmSmartAccount.js',
      'accounts/evm/toNetworkScopedEvmSmartAccount.js',
      'client/evm/evm.js',
    ]) {
      const source = await read(path);
      expect(source, path).not.toMatch(
        /(?:this|account|smartAccount)\.(?:sendUserOperation|transfer|swap)\(/,
      );
    }
    // ... except a network-scoped smart account's useSpendPermission, which calls the smart account's.
    expect(await read('accounts/evm/toNetworkScopedEvmSmartAccount.js')).toMatch(
      /options\.smartAccount\.useSpendPermission\(/,
    );
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
