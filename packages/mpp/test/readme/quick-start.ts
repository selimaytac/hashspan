// Example from packages/mpp/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region unchanged.
// test/quick-start.int.test.ts runs it as written, against an mppx server and Anvil in Tempo mode, with only the URLs
// redirected. The declaration outside the region stands in for the reader's own key.
import type { Hex } from 'viem';

const privateKey = process.env.MPP_QUICK_START_KEY as Hex;

// #region readme
import { createTxTracker } from '@hashspan/core';
import { withHashspan } from '@hashspan/mpp';
import { withHashspan as withViemHashspan } from '@hashspan/viem';
import { Mppx, tempo } from 'mppx/client';
import { createClient, createPublicClient, http, publicActions, walletActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoChain } from 'viem/chains';

// One tracker for both adapters, so that a payment span links to the payer's own send span and each
// transaction gets one confirm span.
const tracker = createTxTracker();
const account = privateKeyToAccount(privateKey);
const wallet = createClient({ account, chain: tempoChain, transport: http() })
  .extend(publicActions)
  .extend(walletActions)
  .extend(withViemHashspan({ tracker }));

const mppx = Mppx.create({
  methods: [tempo({ account, getClient: () => wallet })],
  polyfill: false,
});
// Registers observers on the client; call it once per client.
const hashspan = withHashspan(mppx, {
  tracker,
  reader: createPublicClient({ chain: tempoChain, transport: http() }),
});

await mppx.fetch('https://api.example.com/weather'); // payment span, then confirm span

// Before a short-lived process exits:
await hashspan.flush();
// #endregion
