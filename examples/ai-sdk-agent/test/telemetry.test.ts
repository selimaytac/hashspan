import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentResource } from '../src/telemetry.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the example agent's service", () => {
  it('is treasury-agent by default', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
    expect(agentResource().attributes['service.name']).toBe('treasury-agent');
  });

  it('follows OTEL_SERVICE_NAME, as backend guides ask', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'my-agent');
    expect(agentResource().attributes['service.name']).toBe('my-agent');
  });

  it('takes other resource attributes from OTEL_RESOURCE_ATTRIBUTES', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv(
      'OTEL_RESOURCE_ATTRIBUTES',
      'service.name=from-attributes,deployment.environment.name=dev',
    );
    const { attributes } = agentResource();
    expect(attributes['service.name']).toBe('from-attributes');
    expect(attributes['deployment.environment.name']).toBe('dev');
  });
});
