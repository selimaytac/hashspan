// Run as its own process by flush-process.test.ts: pending work that holds no timer or socket must not let the
// process exit before flush() resolves, and whatever flush() cannot wait for must still be exported.
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { withHashspan } from '../../src/index.js';
import { HASH, mockTransport } from '../mock-transport.js';

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

const hashspan = withHashspan({ decodeRevertReason: { timeoutMs: 60_000 } });
const reader = createPublicClient({
  chain: base,
  // The receipt is reverted, and the revert reason replay never answers.
  transport: mockTransport({
    receipt: { status: '0x0' },
    callRevertData: '0x08c379a0',
    callHangs: true,
  }).transport,
}).extend(hashspan);

await reader.waitForTransactionReceipt({ hash: HASH });
const flushed = await hashspan.flush({ timeoutMs: 300 });

const spans = exporter.getFinishedSpans().map((span) => ({
  name: span.name,
  status: span.attributes['blockchain.tx.status'],
  reason: span.attributes['blockchain.tx.revert.reason'] ?? null,
}));
const drained = await hashspan.flush({ timeoutMs: 300 });
process.stdout.write(`${JSON.stringify({ flushed, drained, spans })}\n`);
