// An OTLP/HTTP (JSON) receiver for tests whose spans come from child processes: it keeps the spans of every export
// and answers metrics and logs too. Point the child's OTEL_EXPORTER_OTLP_ENDPOINT at `endpoint`, with
// OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ReceivedSpan = {
  service: string;
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
};

// The JSON exporter writes an int as a number.
type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean };
type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpTraces = {
  resourceSpans?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: {
      spans?: {
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        attributes?: OtlpAttribute[];
      }[];
    }[];
  }[];
};

const attributeValue = (value: OtlpValue) => value.stringValue ?? value.intValue ?? value.boolValue;
const attributesOf = (attributes: OtlpAttribute[] = []) =>
  Object.fromEntries(attributes.map(({ key, value }) => [key, attributeValue(value)]));

export type OtlpReceiver = {
  /** The base URL, for OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint: string;
  /** Every span received so far; empty it between tests with `received.length = 0`. */
  received: ReceivedSpan[];
  close(): Promise<void>;
};

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const received: ReceivedSpan[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.url === '/v1/traces') {
        for (const resourceSpans of (JSON.parse(body) as OtlpTraces).resourceSpans ?? []) {
          const service = attributesOf(resourceSpans.resource?.attributes)['service.name'];
          for (const scopeSpans of resourceSpans.scopeSpans ?? [])
            for (const span of scopeSpans.spans ?? [])
              received.push({
                service: String(service),
                name: span.name,
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId || undefined,
                attributes: attributesOf(span.attributes),
              });
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
