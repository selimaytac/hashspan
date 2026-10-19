import { OpenTelemetry } from '@ai-sdk/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { registerTelemetry } from 'ai';

/**
 * Standard OpenTelemetry setup: spans go over OTLP to http://localhost:4318 (Jaeger in the local lab), or to
 * `OTEL_EXPORTER_OTLP_ENDPOINT`; `OTEL_TRACES_EXPORTER=console` prints them instead. hashspan itself only needs
 * `@opentelemetry/api`; any SDK setup works.
 */
export function startTelemetry(): { shutdown: () => Promise<void> } {
  const sdk = new NodeSDK({ serviceName: 'research-agent' });
  sdk.start();
  // The AI SDK emits GenAI spans (invoke_agent, execute_tool, ...) through the same provider.
  registerTelemetry(new OpenTelemetry());
  return { shutdown: () => sdk.shutdown() };
}
