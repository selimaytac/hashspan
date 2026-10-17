// Example from skills/hashspan/SKILL.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the skill shows the region
// unchanged. The skill presents it as a complete file; the skill tests in examples/*/test/skill.int.test.ts
// write it into a project and run it.

// #region readme
import { NodeSDK } from '@opentelemetry/sdk-node';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318, or to OTEL_EXPORTER_OTLP_ENDPOINT.
const sdk = new NodeSDK({ serviceName: 'my-service' });
sdk.start();

// One result for every client of the process, so that confirm spans link to their send spans.
export const hashspan = withHashspan();

// hashspan's pending spans first, then the SDK's.
export async function shutdown(): Promise<void> {
  await hashspan.flush();
  await sdk.shutdown();
}

// A service that is stopped flushes too.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit());
  });
}
// #endregion
