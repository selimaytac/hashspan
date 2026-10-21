// Tests the corpus of the backend matrix (scripts/backends/corpus.mjs) and its OTLP encoding: what is sent must be
// what the diff expects, over both transports, without a backend.
import { describe, expect, it } from 'vitest';
import {
  CORPUS_ID,
  corpusHash,
  expectedMetricCounts,
  KIND,
  METRICS,
  RESOURCE,
  readableSpans,
  resourceMetrics,
  SPANS,
  STATUS,
  spanIdOf,
  TRANSPORTS,
  traceIdOf,
  traceIds,
} from '../../../scripts/backends/corpus.mjs';
import { diffSpans } from '../../../scripts/backends/diff.mjs';
import { encodeMetrics, encodeTraces, expectedSpans } from '../../../scripts/backends/otlp.mjs';

const SEND_TIME = Date.UTC(2026, 9, 21, 12, 0, 0);
const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));

describe('backend matrix corpus', () => {
  it('covers every kind, attribute type, status, event, link and scope case the matrix reports on', () => {
    expect(new Set(SPANS.map((s) => s.kind))).toEqual(new Set(Object.values(KIND)));
    const values = SPANS.flatMap((s) => Object.values(s.attributes ?? {}));
    const types = new Set(values.map((v) => (Array.isArray(v) ? 'array' : typeof v)));
    expect(types).toEqual(new Set(['string', 'number', 'boolean', 'array']));
    expect(values.some((v) => typeof v === 'number' && !Number.isInteger(v))).toBe(true);
    expect(values.some((v) => typeof v === 'string' && v.length >= 4096)).toBe(true);
    expect(values.some((v) => typeof v === 'string' && /[^ -~]/.test(v))).toBe(true);
    expect(SPANS.some((s) => s.status?.code === STATUS.ERROR && s.status.message)).toBe(true);
    expect(SPANS.some((s) => s.events?.some((e) => e.name === 'exception'))).toBe(true);
    expect(SPANS.some((s) => s.events?.some((e) => e.name !== 'exception' && e.attributes))).toBe(
      true,
    );
    expect(SPANS.some((s) => s.links?.some((l) => l.trace !== s.trace))).toBe(true);
    expect(SPANS.some((s) => s.links?.some((l) => l.trace === s.trace))).toBe(true);
    expect(Math.max(...SPANS.map((s) => s.links?.length ?? 0))).toBeGreaterThanOrEqual(5);
    // Three levels of nesting: root, producer, consumer.
    expect(SPANS.find((s) => s.key === 'consumer')?.parent).toBe('producer');
    expect(new Set(SPANS.map((s) => s.scope ?? 'app'))).toEqual(new Set(['app', 'rpc']));
    expect(Object.values(RESOURCE).map((v) => typeof v)).toEqual(
      expect.arrayContaining(['string', 'number', 'boolean']),
    );
  });

  it('names the three histograms of docs/semconv.md', () => {
    expect(METRICS.map((m) => [m.name, m.unit])).toEqual([
      ['blockchain.client.send.duration', 's'],
      ['blockchain.client.confirmation.duration', 's'],
      ['blockchain.client.fee', '{wei}'],
    ]);
    expect(expectedMetricCounts()).toEqual({
      'blockchain.client.send.duration': {
        count: 4,
        by: { none: 3, TransactionExecutionError: 1 },
      },
      'blockchain.client.confirmation.duration': { count: 3, by: { success: 2, reverted: 1 } },
      'blockchain.client.fee': { count: 3, by: { success: 2, reverted: 1 } },
    });
  });

  it('has the same ids on every run and other ids per transport', () => {
    expect(traceIdOf('http/protobuf', 'a')).toBe(traceIdOf('http/protobuf', 'a'));
    expect(traceIdOf('http/protobuf', 'a')).toMatch(/^[0-9a-f]{32}$/);
    expect(spanIdOf('http/json', 'a', 'send')).toMatch(/^[0-9a-f]{16}$/);
    const [protobuf, json] = TRANSPORTS.map((t) =>
      readableSpans(t, SEND_TIME).map((s) => s.spanContext().spanId),
    );
    expect(new Set([...(protobuf ?? []), ...(json ?? [])]).size).toBe(SPANS.length * 2);
    expect(Object.values(traceIds('http/protobuf'))).not.toContain(traceIds('http/json').a);
    expect(corpusHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(CORPUS_ID).toBe('synthetic-1');
  });

  it('times every span relative to the send time', () => {
    const spans = readableSpans('http/json', SEND_TIME);
    const starts = spans.map((s) => s.startTime[0] * 1000 + s.startTime[1] / 1e6);
    expect(Math.min(...starts)).toBe(SEND_TIME);
    const later = readableSpans('http/json', SEND_TIME + 5000);
    expect(later[0]?.startTime[0]).toBe((spans[0]?.startTime[0] ?? 0) + 5);
  });

  it.each(TRANSPORTS)(
    'reads back as itself over %s through the OTLP JSON normalizer',
    (transport) => {
      const expected = expectedSpans(transport, SEND_TIME);
      expect(expected).toHaveLength(SPANS.length);
      // Built from the corpus data directly, apart from the serializer, so the two paths check each other.
      const direct = SPANS.map((s) => ({
        traceId: traceIdOf(transport, s.trace),
        spanId: spanIdOf(transport, s.trace, s.key),
        parent: s.parent ? spanIdOf(transport, s.trace, s.parent) : null,
        name: s.name,
        kind: s.kind,
        status: { code: s.status?.code ?? 0, message: s.status?.message },
        attributes: s.attributes ?? {},
        events: (s.events ?? []).map((e) => ({ name: e.name, attributes: e.attributes })),
        links: (s.links ?? []).map((l) => ({
          traceId: traceIdOf(transport, l.trace),
          spanId: spanIdOf(transport, l.trace, l.span),
          attributes: l.attributes,
        })),
        resource: { ...RESOURCE, 'service.instance.id': `corpus-${transport.slice(5)}` },
        scope: {
          name: s.scope === 'rpc' ? 'hashspan-corpus-rpc' : 'hashspan-corpus',
          version: s.scope === 'rpc' ? '0.1.0' : '1.0.0',
          attributes: s.scope === 'rpc' ? {} : { 'corpus.scope.role': 'app' },
        },
      }));
      const { summary, differences } = diffSpans(direct, expected);
      expect(differences).toEqual([]);
      expect(summary).toMatchObject({ spans: SPANS.length, resourceDiff: 0, scopeDiff: 0 });
    },
  );

  it('encodes the JSON transport as OTLP JSON with hex ids and the protobuf one as binary', () => {
    const json = encodeTraces('http/json', SEND_TIME);
    expect(json.contentType).toBe('application/json');
    const request = decode(json.body);
    expect(request.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(
      traceIdOf('http/json', 'a'),
    );
    const protobuf = encodeTraces('http/protobuf', SEND_TIME);
    expect(protobuf.contentType).toBe('application/x-protobuf');
    const bytes = Buffer.from(protobuf.body);
    // Ids are raw bytes in protobuf, and strings stay UTF-8.
    expect(bytes.includes(Buffer.from(traceIdOf('http/protobuf', 'a'), 'hex'))).toBe(true);
    expect(bytes.includes(Buffer.from('支払い完了', 'utf8'))).toBe(true);
    expect(() => encodeTraces('grpc', SEND_TIME)).toThrow('unknown transport');
  });

  it('encodes the histograms as cumulative OTLP histograms with their bucket counts', () => {
    const request = decode(encodeMetrics('http/json', SEND_TIME).body);
    const metrics = request.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.map((m: { name: string }) => m.name)).toEqual(METRICS.map((m) => m.name));
    const send = metrics[0].histogram;
    expect(send.aggregationTemporality).toBe(2);
    expect(send.dataPoints[0].count).toBe(3);
    expect(send.dataPoints[0].bucketCounts.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(resourceMetrics('http/json', SEND_TIME).resource.attributes['service.instance.id']).toBe(
      'corpus-json',
    );
    expect(encodeMetrics('http/protobuf', SEND_TIME).body.length).toBeGreaterThan(100);
  });
});
