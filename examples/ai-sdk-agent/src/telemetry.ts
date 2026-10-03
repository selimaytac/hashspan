import { OpenTelemetry } from '@ai-sdk/otel';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  detectResources,
  envDetector,
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { registerTelemetry } from 'ai';

/**
 * The service the spans belong to: `treasury-agent`, unless `OTEL_SERVICE_NAME` or `OTEL_RESOURCE_ATTRIBUTES` say
 * otherwise. A `NodeTracerProvider` does not read those variables by itself (`NodeSDK` does), so they are detected here.
 */
export function telemetryResource(): Resource {
  return resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'treasury-agent' }).merge(
    detectResources({ detectors: [envDetector] }),
  );
}

/**
 * hashspan's send, confirmation and fee histograms, exported over OTLP when `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is
 * set (Prometheus in the local lab with `make lab-metrics`); undefined otherwise, so a trace-only backend such as
 * Jaeger receives no metric requests. `OTEL_METRIC_EXPORT_INTERVAL` sets the interval in milliseconds.
 */
export function startMetrics(): MeterProvider | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) return undefined;
  const interval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL);
  const provider = new MeterProvider({
    resource: telemetryResource(),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(), // honours OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
        exportIntervalMillis: Number.isInteger(interval) && interval > 0 ? interval : 5_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  return provider;
}

/**
 * Standard OpenTelemetry setup: spans go to an OTLP endpoint (Jaeger in the local lab), or to the console with
 * `OTEL_TRACES_EXPORTER=console`; metrics too when an endpoint for them is set ({@link startMetrics}). hashspan itself
 * only needs `@opentelemetry/api`; any SDK setup works.
 */
export function startTelemetry(): { shutdown: () => Promise<void> } {
  const processor: SpanProcessor =
    process.env.OTEL_TRACES_EXPORTER === 'console'
      ? new SimpleSpanProcessor(new ConsoleSpanExporter())
      : new BatchSpanProcessor(new OTLPTraceExporter()); // honours OTEL_EXPORTER_OTLP_ENDPOINT
  const provider = new NodeTracerProvider({
    resource: telemetryResource(),
    spanProcessors: [processor],
  });
  provider.register();

  // The AI SDK emits GenAI spans (invoke_agent, execute_tool, ...) through the same provider.
  registerTelemetry(new OpenTelemetry());

  const meterProvider = startMetrics();

  return {
    shutdown: async () => {
      // A short-lived process: shutting down exports the last metric samples, after the last spans.
      await provider.shutdown();
      await meterProvider?.shutdown();
    },
  };
}
