import { startTelemetry } from './telemetry.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry();
const { runDemo } = await import('./demo.js');
const { baseSepoliaChain, DemoSetupError, EXPLORER } = await import('./base-sepolia.js');

// `base-sepolia` runs on the public testnet; anything else on the local chain at RPC_URL.
const onBaseSepolia = process.argv[2] === 'base-sepolia';

try {
  const { text, toolResults } = await runDemo(onBaseSepolia ? await baseSepoliaChain() : undefined);
  console.log(text);
  for (const { toolName, output } of toolResults) {
    console.log(`${toolName}:`, output);
    const hash = (output as { hash?: unknown } | undefined)?.hash;
    if (onBaseSepolia && typeof hash === 'string') console.log(`  ${EXPLORER}/tx/${hash}`);
  }
} catch (error) {
  if (!onBaseSepolia) throw error;
  // Setup errors are written to be safe to print; others are reduced to their short message, since viem's full
  // messages include the RPC URL, which may carry an API key.
  const message =
    error instanceof DemoSetupError
      ? error.message
      : ((error as { shortMessage?: string }).shortMessage ?? (error as Error).name);
  console.error(`demo: ${message}`);
  process.exitCode = 1;
}

await telemetry.shutdown();
if (!process.exitCode) {
  console.log(
    '\nTraces sent. Open http://localhost:16686 and search for service "treasury-agent".',
  );
}
