// Example from packages/viem/README.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the README shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();
declare const provider: { shutdown(): Promise<void> };

// #region readme
await hashspan.flush(); // at most 10 s by default: hashspan.flush({ timeoutMs })
await provider.shutdown();
// #endregion
