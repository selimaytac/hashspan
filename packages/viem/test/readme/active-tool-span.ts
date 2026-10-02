// Example from docs/integrations.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the document shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import { trace } from '@opentelemetry/api';
import type { Address } from 'viem';

declare const wallet: {
  sendTransaction(args: { to: Address; value: bigint }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<unknown>;
};
declare const to: Address;
declare const value: bigint;

// #region readme
const tracer = trace.getTracer('treasury-agent');

// The tool's function: its send and confirm spans become children of `pay_vendor`.
async function payVendor(): Promise<`0x${string}`> {
  return tracer.startActiveSpan('pay_vendor', async (span) => {
    try {
      const hash = await wallet.sendTransaction({ to, value });
      await wallet.waitForTransactionReceipt({ hash });
      return hash;
    } finally {
      span.end();
    }
  });
}
// #endregion
