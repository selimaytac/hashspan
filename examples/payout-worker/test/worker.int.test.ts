import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startAnvil } from '../../../packages/viem/test/start-anvil.js';
import { PAYOUTS, prepareLocalChain, REFUSER } from '../src/chain.js';
import { createPayoutWorker } from '../src/worker.js';

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });

beforeAll(async () => {
  tracerProvider.register();
  metrics.setGlobalMeterProvider(meterProvider);
  await prepareLocalChain(rpcUrl);
});
afterAll(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  metrics.disable();
  await instance.stop();
});

it('traces each payout in its own trace, with no agent, confirmed in the background', async () => {
  const results = await createPayoutWorker(rpcUrl).run(PAYOUTS);

  expect(results.map(({ id, hash }) => [id, typeof hash])).toEqual([
    ['po-1', 'string'],
    ['po-2', 'string'],
    ['po-3', 'undefined'],
  ]);
  const spans = spanExporter.getFinishedSpans();
  const jobs = spans.filter((span) => span.name.startsWith('payout '));
  expect(jobs).toHaveLength(3);
  for (const job of jobs) {
    const children = spans.filter(
      (span) => span.parentSpanContext?.spanId === job.spanContext().spanId,
    );
    const names = children.map((span) => span.name).sort();
    // The refused payout fails at the send; the others are sent and confirmed under their job.
    expect(names).toEqual(
      job.name === 'payout po-3' ? ['send 31337'] : ['confirm 31337', 'send 31337'],
    );
    for (const span of children) {
      expect(Object.keys(span.attributes).some((key) => key.startsWith('gen_ai.'))).toBe(false);
    }
  }
  expect(new Set(jobs.map((job) => job.spanContext().traceId)).size).toBe(3);
  const refused = spans.find(
    (span) => span.name === 'send 31337' && span.attributes['blockchain.tx.to'] === REFUSER,
  );
  expect(refused?.status.code).toBe(SpanStatusCode.ERROR);

  // Every confirmed payout records a confirmation sample, whatever its trace.
  await metricReader.forceFlush();
  const confirmation = metricExporter
    .getMetrics()
    .flatMap(({ scopeMetrics }) => scopeMetrics.flatMap(({ metrics: list }) => list))
    .find(({ descriptor }) => descriptor.name === 'blockchain.client.confirmation.duration');
  const count = confirmation?.dataPoints.reduce(
    (sum, { value }) => sum + (value as { count: number }).count,
    0,
  );
  expect(count).toBe(2);
});
