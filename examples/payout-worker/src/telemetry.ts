import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Standard OpenTelemetry setup for the service `payout-worker`: spans go to an OTLP endpoint (Jaeger in the local
 * lab); hashspan's send, confirmation and fee histograms too, when `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is set
 * (Prometheus with `make lab-metrics`). hashspan itself only needs `@opentelemetry/api`.
 */
export function startTelemetry(): { shutdown: () => Promise<void> } {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'payout-worker' }).merge(
    detectResources({ detectors: [envDetector] }),
  );
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())], // honours OTEL_EXPORTER_OTLP_ENDPOINT
  });
  tracerProvider.register();
  const meterProvider = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ? new MeterProvider({
        resource,
        readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
      })
    : undefined;
  if (meterProvider) metrics.setGlobalMeterProvider(meterProvider);
  return {
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider?.shutdown();
    },
  };
}
