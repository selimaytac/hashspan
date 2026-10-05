import { startTelemetry } from './telemetry.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry();
const { createPayoutWorker } = await import('./worker.js');
const { PAYOUTS, prepareLocalChain } = await import('./chain.js');

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
await prepareLocalChain(rpcUrl);
for (const { id, hash, error } of await createPayoutWorker(rpcUrl).run(PAYOUTS)) {
  console.log(`${id}: ${hash ?? `failed (${error})`}`);
}

try {
  await telemetry.shutdown();
  console.log('\nTraces sent. Open http://localhost:16686 and search for service "payout-worker".');
} catch {
  console.error('\nCould not export the traces: is the trace backend running (`make lab-up`)?');
  process.exitCode = 1;
}
