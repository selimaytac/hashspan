import { startTelemetry } from './telemetry.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry();
const { runDemo } = await import('./demo.js');

const { text, toolResults } = await runDemo();
console.log(text);
for (const { toolName, output } of toolResults) console.log(`${toolName}:`, output);

await telemetry.shutdown();
console.log('\nTraces sent. Open http://localhost:16686 and search for service "treasury-agent".');
