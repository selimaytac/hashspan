// The payout worker before hashspan: a long-running service that pays out from a queue in a span per job and never
// waits for receipts. skill.int.test.ts applies skills/hashspan/SKILL.md to a copy of this folder and runs it.
import { trace } from '@opentelemetry/api';
import { createWalletClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

const queue = [
  { id: 'po-1', to: '0x00000000000000000000000000000000000000c1', value: 1_000_000_000_000_000n },
  { id: 'po-2', to: '0x00000000000000000000000000000000000000c2', value: 2_000_000_000_000_000n },
] as const;

const wallet = createWalletClient({
  account: mnemonicToAccount('test test test test test test test test test test test junk'),
  chain: anvil,
  transport: http(process.env.RPC_URL ?? 'http://127.0.0.1:8545'),
  pollingInterval: 100,
});
const tracer = trace.getTracer('payout-worker');

for (const payout of queue) {
  await tracer.startActiveSpan(`payout ${payout.id}`, async (span) => {
    try {
      const hash = await wallet.sendTransaction({ to: payout.to, value: payout.value });
      console.log(`${payout.id}: ${hash}`);
    } finally {
      span.end();
    }
  });
}

// Waits for more payouts until the process is stopped.
console.log('waiting for payouts');
setInterval(() => {}, 1_000);
