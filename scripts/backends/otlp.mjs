// Encodes the corpus with the serializers the OpenTelemetry JS OTLP exporters use, and posts it over OTLP/HTTP.
import {
  JsonMetricsSerializer,
  JsonTraceSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from '@opentelemetry/otlp-transformer';
import { readableSpans, resourceMetrics } from './corpus.mjs';
import { fromOtlpJson } from './normalize.mjs';

const CONTENT_TYPE = { 'http/protobuf': 'application/x-protobuf', 'http/json': 'application/json' };

/**
 * A serialized request body; the serializers return undefined only when they fail.
 * @param {Uint8Array | undefined} body
 * @returns {Uint8Array}
 */
function bodyOf(body) {
  if (body === undefined) throw new Error('the OTLP serializer returned no body');
  return body;
}

/**
 * The corpus spans as an OTLP/HTTP request body for the transport.
 * @param {string} transport
 * @param {number} sendTime
 * @returns {{ body: Uint8Array, contentType: string }}
 */
export function encodeTraces(transport, sendTime) {
  const spans = readableSpans(transport, sendTime);
  const serializer = transport === 'http/json' ? JsonTraceSerializer : ProtobufTraceSerializer;
  return { body: bodyOf(serializer.serializeRequest(spans)), contentType: CONTENT_TYPE[transport] };
}

/**
 * What a transport's copy of the corpus should read back as: its spans through the OTLP JSON serializer and the
 * normalizer of OTLP JSON read-backs, so the expected side and the sent bytes come from one source.
 */
export function expectedSpans(transport, sendTime) {
  const body = bodyOf(JsonTraceSerializer.serializeRequest(readableSpans(transport, sendTime)));
  return fromOtlpJson(JSON.parse(new TextDecoder().decode(body)).resourceSpans);
}

/**
 * The corpus metrics as an OTLP/HTTP request body for the transport.
 * @param {string} transport
 * @param {number} sendTime
 * @returns {{ body: Uint8Array, contentType: string }}
 */
export function encodeMetrics(transport, sendTime) {
  const serializer = transport === 'http/json' ? JsonMetricsSerializer : ProtobufMetricsSerializer;
  return {
    body: bodyOf(serializer.serializeRequest(resourceMetrics(transport, sendTime))),
    contentType: CONTENT_TYPE[transport],
  };
}

/**
 * Posts an encoded body and returns the HTTP status only (0 when the request failed), so a backend that refuses a
 * signal (for example 404 on /v1/metrics) is a result, not a crash.
 */
export async function post(url, { body, contentType }, headers = {}) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': contentType },
      body,
    });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
}
