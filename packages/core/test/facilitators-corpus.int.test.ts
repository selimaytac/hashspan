// Checks the committed facilitator corpus on a local Anvil, with the chain setup of the matrix (scripts/facilitators/
// chain.mjs): chain id 84532 and a genesis time of 2024-01-01, so a committed payload is judged at the time it was
// signed for. The token contract itself checks the signature and the validity window; no facilitator runs here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseSignature } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainOf, readBalances, setupChain } from '../../../scripts/facilitators/chain.mjs';
import {
  ACCOUNTS,
  addressOf,
  CHAIN_ID,
  CORPUS_FILE,
  FUNDS,
  PAY_TO,
  T0,
  TOKEN,
} from '../../../scripts/facilitators/corpus.mjs';
import { startAnvil } from '../../viem/test/start-anvil.js';
import { testUsdAbi } from '../../x402/test/token/test-usd.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, CORPUS_FILE), 'utf8'));

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  chainId: CHAIN_ID,
  timestamp: T0,
});
const reader = createPublicClient({ chain: chainOf(rpcUrl), transport: http(rpcUrl) });

beforeAll(async () => {
  await setupChain(rpcUrl);
});
afterAll(async () => {
  await instance.stop();
});

/** Simulates the facilitator's transferWithAuthorization call of a committed case's first payload. */
function transfer(id: string) {
  const { paymentPayload } = corpus.cases.find((c: { id: string }) => c.id === id);
  const { authorization, signature } = paymentPayload.payload;
  const { v, yParity, r, s } = parseSignature(signature);
  return reader.simulateContract({
    account: addressOf(ACCOUNTS.facilitator),
    address: TOKEN,
    abi: testUsdAbi,
    functionName: 'transferWithAuthorization',
    args: [
      authorization.from,
      authorization.to,
      BigInt(authorization.value),
      BigInt(authorization.validAfter),
      BigInt(authorization.validBefore),
      authorization.nonce,
      Number(v ?? BigInt(yParity + 27)),
      r,
      s,
    ],
  });
}

describe('facilitator corpus on Anvil', () => {
  it('runs the chain at the corpus time, with the token where the corpus signed for it', async () => {
    const block = await reader.getBlock();
    expect(Number(block.timestamp)).toBeGreaterThanOrEqual(T0);
    expect(Number(block.timestamp)).toBeLessThan(T0 + 3600);
    expect(await reader.getChainId()).toBe(CHAIN_ID);
    expect(await reader.getCode({ address: TOKEN })).toMatch(/^0x[0-9a-f]{100,}/);
    const balances = await readBalances(rpcUrl);
    expect(balances.payer).toBe(String(FUNDS));
    expect(balances.payTo).toBe('0');
    expect(PAY_TO).toMatch(/^0x0{38}cc$/);
  });

  it('accepts the signature of a valid committed payload on chain', async () => {
    await expect(transfer('exact-eip3009-valid')).resolves.toBeDefined();
  });

  it('rejects an expired committed payload on chain', async () => {
    await expect(transfer('exact-eip3009-expired')).rejects.toThrow('authorization is expired');
  });

  it('rejects the bad signature on chain', async () => {
    await expect(transfer('exact-eip3009-bad-signature')).rejects.toThrow('invalid signature');
  });
});
