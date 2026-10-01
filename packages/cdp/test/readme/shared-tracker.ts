// Example from packages/cdp/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { CdpClient } from '@coinbase/cdp-sdk';
import { withHashspan } from '@hashspan/cdp';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const cdp = new CdpClient();

// #region readme
import { createTxTracker } from '@hashspan/core';
import { withHashspan as withViemHashspan } from '@hashspan/viem';

const tracker = createTxTracker({ agent: { name: 'treasury-bot' } });
const hashspanViem = withViemHashspan({ tracker });
const reader = createPublicClient({ chain: baseSepolia, transport: http() }).extend(hashspanViem);
const hashspanCdp = withHashspan(cdp, { tracker, reader });

// At shutdown, flush both:
await Promise.all([hashspanCdp.flush(), hashspanViem.flush()]);
// #endregion
