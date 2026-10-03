import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMetrics, telemetryResource } from '../src/telemetry.js';

describe('telemetryResource', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names the service treasury-agent by default', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
    expect(telemetryResource().attributes[ATTR_SERVICE_NAME]).toBe('treasury-agent');
  });

  it('takes the service name from OTEL_SERVICE_NAME', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'my-agent');
    expect(telemetryResource().attributes[ATTR_SERVICE_NAME]).toBe('my-agent');
  });

  it('takes resource attributes from OTEL_RESOURCE_ATTRIBUTES', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv(
      'OTEL_RESOURCE_ATTRIBUTES',
      'service.name=from-attributes,deployment.environment.name=staging',
    );
    const { attributes } = telemetryResource();
    expect(attributes[ATTR_SERVICE_NAME]).toBe('from-attributes');
    expect(attributes['deployment.environment.name']).toBe('staging');
  });
});

describe('startMetrics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports no metrics without a metrics endpoint, so Jaeger gets no metric requests', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', '');
    expect(startMetrics()).toBeUndefined();
  });

  it('starts a meter provider when a metrics endpoint is set', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://127.0.0.1:9/v1/metrics');
    vi.stubEnv('OTEL_METRIC_EXPORT_INTERVAL', '1000');
    const provider = startMetrics();
    expect(provider).toBeDefined();
    await provider?.shutdown({ timeoutMillis: 100 }).catch(() => {});
  });
});
