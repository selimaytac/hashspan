import { OpenTelemetry } from '@ai-sdk/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  detectResources,
  envDetector,
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
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
 * Standard OpenTelemetry setup: spans go to an OTLP endpoint (Jaeger in the local lab), or to the console with
 * `OTEL_TRACES_EXPORTER=console`. hashspan itself only needs `@opentelemetry/api`; any SDK setup works.
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

  return { shutdown: () => provider.shutdown() };
}
