import { context, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export interface TestTracing {
  exporter: InMemorySpanExporter;
  spans: () => ReadableSpan[];
  spanNamed: (name: string) => ReadableSpan;
  teardown: () => Promise<void>;
}

/** Registers a global tracer provider with an async context manager and an in-memory exporter. */
export function setupTracing(): TestTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
  return {
    exporter,
    spans,
    spanNamed: (name) => {
      const span = spans().find((s) => s.name === name);
      if (!span) throw new Error(`no span named "${name}" in [${spans().map((s) => s.name)}]`);
      return span;
    },
    teardown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
