// An OTLP/HTTP receiver for tests whose spans come from child processes: it keeps the spans of every export and
// answers metrics and logs too. Point the child's OTEL_EXPORTER_OTLP_ENDPOINT at `endpoint`, with
// OTEL_EXPORTER_OTLP_PROTOCOL=http/json. It also reads traces in protobuf (`application/x-protobuf`), the only
// encoding of Go's OTLP/HTTP exporter, which eRPC uses (erpc.int.test.ts).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

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
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
      const protobuf = request.headers['content-type'] === 'application/x-protobuf';
      if (request.url === '/v1/traces') {
        const traces = protobuf
          ? decodeTraces(body)
          : (JSON.parse(body.toString('utf8')) as OtlpTraces);
        for (const resourceSpans of traces.resourceSpans ?? []) {
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
      // An empty message is a complete ExportTraceServiceResponse in protobuf.
      response.writeHead(200, {
        'content-type': protobuf ? 'application/x-protobuf' : 'application/json',
      });
      response.end(protobuf ? '' : '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// A protobuf ExportTraceServiceRequest, decoded into the shape of the JSON encoding for the fields above (field numbers
// from opentelemetry-proto v1.5.0: collector/trace, trace, resource and common). Ids become hex strings, as in JSON.
type Field = { number: number; wire: number; value: bigint | Buffer };

/** The fields of one protobuf message, in order. */
function fieldsOf(message: Buffer): Field[] {
  const fields: Field[] = [];
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = message[offset++];
      if (byte === undefined) throw new Error('truncated protobuf varint');
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
  };
  const take = (length: number): Buffer => {
    if (offset + length > message.length) throw new Error('truncated protobuf field');
    const bytes = message.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };
  while (offset < message.length) {
    const key = Number(varint());
    const wire = key & 7;
    const number = key >>> 3;
    if (wire === 0) fields.push({ number, wire, value: varint() });
    else if (wire === 1) fields.push({ number, wire, value: take(8) });
    else if (wire === 2) fields.push({ number, wire, value: take(Number(varint())) });
    else if (wire === 5) fields.push({ number, wire, value: take(4) });
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return fields;
}

const bytesOf = (fields: Field[], number: number): Buffer[] =>
  fields.flatMap((field) =>
    field.number === number && field.value instanceof Buffer ? [field.value] : [],
  );

function decodeValue(message: Buffer): OtlpValue {
  for (const field of fieldsOf(message)) {
    if (field.number === 1 && field.value instanceof Buffer)
      return { stringValue: field.value.toString('utf8') };
    if (field.number === 2 && typeof field.value === 'bigint')
      return { boolValue: field.value !== 0n };
    if (field.number === 3 && typeof field.value === 'bigint')
      return { intValue: Number(BigInt.asIntN(64, field.value)) };
  }
  return {};
}

function decodeAttributes(messages: Buffer[]): OtlpAttribute[] {
  return messages.map((message) => {
    const fields = fieldsOf(message);
    const value = bytesOf(fields, 2)[0];
    return {
      key: bytesOf(fields, 1)[0]?.toString('utf8') ?? '',
      value: value === undefined ? {} : decodeValue(value),
    };
  });
}

function decodeTraces(body: Buffer): OtlpTraces {
  return {
    resourceSpans: bytesOf(fieldsOf(body), 1).map((resourceSpans) => {
      const fields = fieldsOf(resourceSpans);
      const resource = bytesOf(fields, 1)[0];
      return {
        resource: {
          attributes:
            resource === undefined ? [] : decodeAttributes(bytesOf(fieldsOf(resource), 1)),
        },
        scopeSpans: bytesOf(fields, 2).map((scopeSpans) => ({
          spans: bytesOf(fieldsOf(scopeSpans), 2).map((span) => {
            const spanFields = fieldsOf(span);
            const hex = (number: number) => bytesOf(spanFields, number)[0]?.toString('hex') ?? '';
            return {
              traceId: hex(1),
              spanId: hex(2),
              parentSpanId: hex(4),
              name: bytesOf(spanFields, 5)[0]?.toString('utf8') ?? '',
              attributes: decodeAttributes(bytesOf(spanFields, 9)),
            };
          }),
        })),
      };
    }),
  };
}
