import { withHashspan } from '@hashspan/viem';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { type Address, createWalletClient, type Hex, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

export interface Payout {
  id: string;
  to: Address;
  value: bigint;
}

export interface PayoutResult {
  id: string;
  hash?: Hex;
  error?: string;
}

/** Anvil's first test account, from its public default mnemonic: a local signer, as a service's own key would be. */
const signer = mnemonicToAccount('test test test test test test test test test test test junk');

/**
 * A worker that pays out from a queue. It is not an agent: each payout runs in a span of its own, which hashspan's
 * send and confirm spans nest under, and no agent identity is set; the service name tells the worker apart.
 */
export function createPayoutWorker(rpcUrl: string) {
  // A worker sends and moves on: hashspan confirms each transaction in the background.
  const hashspan = withHashspan({ confirm: { mode: 'background', timeoutMs: 30_000 } });
  const wallet = createWalletClient({
    account: signer,
    chain: anvil,
    transport: http(rpcUrl),
    pollingInterval: 100,
  }).extend(hashspan);
  const tracer = trace.getTracer('payout-worker');

  const pay = (payout: Payout): Promise<PayoutResult> =>
    tracer.startActiveSpan(`payout ${payout.id}`, async (span) => {
      span.setAttribute('payout.id', payout.id);
      try {
        const hash = await wallet.sendTransaction({ to: payout.to, value: payout.value });
        return { id: payout.id, hash };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        // viem's short message leaves out the request, which can carry the RPC URL.
        const message = (error as { shortMessage?: string }).shortMessage ?? (error as Error).name;
        return { id: payout.id, error: message };
      } finally {
        span.end();
      }
    });

  return {
    /** Pays each payout in turn, then waits for the background confirmations, as a job does before it exits. */
    async run(payouts: readonly Payout[]): Promise<PayoutResult[]> {
      const results: PayoutResult[] = [];
      for (const payout of payouts) results.push(await pay(payout));
      await hashspan.flush();
      return results;
    },
  };
}
