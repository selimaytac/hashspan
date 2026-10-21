// Tests the diff and the read-back normalizers of the backend matrix (scripts/backends/). The E7 cases run the diff
// on the spans experiment E7 recorded (packages/core/test/fixtures/backends-e7/), which are already in the common
// shape, and must reproduce its findings. The normalizer cases use small responses written for these tests in each
// backend's response format, since E7 kept no raw responses; they are not recordings.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffMetrics, diffSpans, exercised } from '../../../scripts/backends/diff.mjs';
import {
  fromClickHouse,
  fromMlflow,
  fromOpenObserve,
  fromOtlpJson,
  fromPhoenix,
  hexId,
} from '../../../scripts/backends/normalize.mjs';
import { expectedSpans } from '../../../scripts/backends/otlp.mjs';
import { E7_BACKENDS, readE7Fixture } from '../../../scripts/backends/seed-e7.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

type Difference = Record<string, unknown> & { check: string };

/** The diff of one E7 backend's recorded spans. */
function e7(name: string) {
  const fixture = readE7Fixture(root, name);
  const { summary, differences } = diffSpans(fixture.sent, fixture.received);
  return { fixture, summary, differences: differences as Difference[] };
}

describe('backend matrix diff on the E7 recordings', () => {
  const names = Object.keys(E7_BACKENDS);

  it('sent links within a trace, across traces and several on one span', () => {
    for (const name of names) {
      const { fixture } = e7(name);
      const x = exercised(fixture.sent, fixture.received);
      expect(x.links).toBe(8);
      expect(x.crossTraceLinks).toBe(1);
      expect(Math.max(...fixture.sent.map((s: { links: unknown[] }) => s.links.length))).toBe(3);
    }
  });

  it('finds every span with its name and parent on all five, and every link kept', () => {
    for (const name of names) {
      const { summary } = e7(name);
      expect({ name, ...summary }).toMatchObject({
        name,
        missing: 0,
        extraSpans: 0,
        nameDiff: 0,
        parentDiff: 0,
        statusDiff: 0,
        eventDiff: 0,
        linkDiff: 0,
        linkAttrDiff: 0,
        attrMissing: 0,
        attrValueDiff: 0,
      });
    }
  });

  it('finds no difference at all on otel-lgtm (Tempo)', () => {
    expect(e7('otel-lgtm').differences).toEqual([]);
  });

  it('finds the span kind dropped on every MLflow span', () => {
    const { summary, differences } = e7('mlflow');
    expect(summary.kindDiff).toBe(66);
    expect(summary.kindDiff).toBe(summary.spans);
    expect(differences.every((d) => d.check === 'kindDiff' && d.got === undefined)).toBe(true);
    expect(summary.attrTypeDiff).toBe(0);
  });

  it.each([
    ['aspire', 129],
    ['openobserve', 123],
    ['hyperdx', 123],
  ])('finds every number attribute of %s returned as its string (%i)', (name, count) => {
    const { summary, differences } = e7(name);
    expect(summary.attrTypeDiff).toBe(count);
    expect(summary.attrStringified).toBe(count);
    expect(summary.kindDiff).toBe(0);
    const types = differences
      .filter((d) => d.check === 'attrTypeDiff')
      .map((d) => `${d.expected} -> ${d.got}`);
    expect(new Set(types)).toEqual(new Set(['number -> string']));
  });

  it('finds the attribute names flattened on OpenObserve only', () => {
    const { fixture, differences } = e7('openobserve');
    const renamed = differences.filter((d) => d.check === 'attrNameDiff');
    expect(renamed).toContainEqual(
      expect.objectContaining({ key: 'blockchain.tx.status', got: 'blockchain_tx_status' }),
    );
    // Every sent attribute name with a dot comes back with underscores.
    const sentNames = fixture.sent.reduce(
      (n: number, s: { attributes: object }) => n + Object.keys(s.attributes).length,
      0,
    );
    expect(renamed).toHaveLength(sentNames);
    for (const name of ['aspire', 'otel-lgtm', 'hyperdx', 'mlflow']) {
      expect(e7(name).summary.attrNameDiff).toBe(0);
    }
  });

  it('counts the metrics E7 read back as exact', () => {
    for (const name of ['otel-lgtm', 'openobserve', 'hyperdx']) {
      const { metrics } = e7(name).fixture;
      expect(diffMetrics(metrics.expected, metrics.got).differences).toEqual([]);
    }
    expect(e7('mlflow').fixture.metrics).toBeNull();
  });
});

describe('backend matrix diff', () => {
  const span = {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parent: null,
    name: 'send 1',
    kind: 2,
    status: { code: 2, message: 'boom' },
    attributes: { 'a.int': 1, 'a.list': ['x'], 'a.text': 'v' },
    events: [{ name: 'exception', attributes: { 'exception.type': 'E', n: 2 } }],
    links: [{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), attributes: { i: 1 } }],
    resource: { 'service.name': 's' },
    scope: { name: 'x', version: '1', attributes: {} },
  };

  it('finds nothing when a span comes back as sent', () => {
    expect(diffSpans([span], [structuredClone(span)]).differences).toEqual([]);
  });

  it('treats an empty status message as an absent one', () => {
    const sent = { ...span, status: { code: 1 } };
    expect(
      diffSpans([sent], [{ ...sent, status: { code: 1, message: '' } }]).summary.statusDiff,
    ).toBe(0);
    expect(diffSpans([span], [{ ...span, status: { code: 2 } }]).summary.statusDiff).toBe(1);
  });

  it('reports each kind of difference under its own counter', () => {
    const got = {
      ...span,
      name: 'other',
      kind: undefined,
      parent: 'e'.repeat(16),
      attributes: { a_int: '1', 'a.list': '["x"]', extra: true },
      events: [{ name: 'exception', attributes: { 'exception.type': 'E', n: '2' } }],
      links: [{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), attributes: {} }],
      resource: { 'service.name': 'other' },
      scope: { name: 'x', version: '2', attributes: {} },
    };
    const extra = { ...span, spanId: 'f'.repeat(16) };
    const { summary } = diffSpans([span], [got, extra]);
    expect(summary).toEqual({
      spans: 1,
      missing: 0,
      extraSpans: 1,
      nameDiff: 1,
      kindDiff: 1,
      parentDiff: 1,
      statusDiff: 0,
      attrMissing: 1,
      attrNameDiff: 1,
      attrTypeDiff: 2,
      attrStringified: 2,
      attrValueDiff: 0,
      attrExtra: 1,
      eventDiff: 0,
      eventAttrDiff: 1,
      linkDiff: 0,
      linkAttrDiff: 1,
      resourceDiff: 1,
      scopeDiff: 1,
    });
    expect(diffSpans([span], []).summary).toMatchObject({ missing: 1, resourceDiff: null });
  });

  it('compares links as a set and events in order', () => {
    const two = {
      ...span,
      links: [span.links[0], { traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), attributes: {} }],
    };
    const reversed = { ...two, links: [...two.links].reverse() };
    expect(diffSpans([two], [reversed]).summary.linkDiff).toBe(0);
    expect(diffSpans([two], [span]).summary.linkDiff).toBe(1);
    expect(diffSpans([span], [{ ...span, events: [] }]).summary.eventDiff).toBe(1);
  });

  it('leaves resource and scope unchecked when the backend does not return them', () => {
    const { summary } = diffSpans([span], [{ ...span, resource: undefined, scope: undefined }]);
    expect(summary.resourceDiff).toBeNull();
    expect(summary.scopeDiff).toBeNull();
  });

  it('compares metric counts in total and per outcome', () => {
    const expected = { m: { count: 3, by: { a: 2, b: 1 } } };
    expect(diffMetrics(expected, { m: { count: 3, by: { b: 1, a: 2 } } }).differences).toEqual([]);
    expect(diffMetrics(expected, { m: { count: 2, by: { a: 2 } } }).differences).toHaveLength(2);
    expect(diffMetrics(expected, {}).differences).toEqual([{ metric: 'm', check: 'missing' }]);
  });
});

describe('backend matrix normalizers', () => {
  // The corpus as sent over JSON is the reference the hand-written responses below are built from.
  const expected = expectedSpans('http/json', Date.UTC(2026, 9, 21));
  const found = expected.find(
    (s) => s.name === 'confirm 31337' && s.links.length === 1 && s.status.code === 2,
  );
  if (!found) throw new Error('the corpus lacks its reverted confirm span');
  const confirm = found;
  const flat = (o: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    );

  it('reads OTLP JSON with base64 ids and enum names, as some query APIs write them', () => {
    const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
    const [span] = fromOtlpJson([
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
        scopeSpans: [
          {
            scope: { name: 'x' },
            spans: [
              {
                traceId: b64(confirm.traceId),
                spanId: b64(confirm.spanId),
                parentSpanId: '',
                name: 'n',
                kind: 'SPAN_KIND_CONSUMER',
                status: { code: 'STATUS_CODE_ERROR', message: 'm' },
                attributes: [
                  { key: 'i', value: { intValue: '9007199254740991' } },
                  { key: 'd', value: { doubleValue: 0.5 } },
                  { key: 'l', value: { arrayValue: { values: [{ boolValue: true }] } } },
                  {
                    key: 'k',
                    value: { kvlistValue: { values: [{ key: 'x', value: { stringValue: 'y' } }] } },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(span).toMatchObject({
      traceId: confirm.traceId,
      spanId: confirm.spanId,
      parent: null,
      kind: 4,
      status: { code: 2, message: 'm' },
      attributes: { i: 9007199254740991, d: 0.5, l: [true], k: { x: 'y' } },
      resource: { 'service.name': 's' },
      scope: { name: 'x', version: undefined, attributes: {} },
      events: [],
      links: [],
    });
    expect(hexId('')).toBeUndefined();
  });

  it('reads OpenObserve hits: flattened names and string values show as such in the diff', () => {
    const attributes = Object.fromEntries(
      Object.entries(flat(confirm.attributes)).map(([k, v]) => [k.replace(/\./g, '_'), v]),
    );
    const hit = {
      trace_id: confirm.traceId,
      span_id: confirm.spanId,
      reference_parent_span_id: confirm.parent,
      operation_name: confirm.name,
      span_kind: '3',
      status_code: 2,
      status_message: confirm.status.message,
      service_name: 'hashspan-backend-matrix',
      ...attributes,
      events: JSON.stringify(
        confirm.events.map((e: { name: string; attributes: object }) => ({
          name: e.name,
          _timestamp: 1,
          ...e.attributes,
        })),
      ),
      links: JSON.stringify(
        confirm.links.map((l: { traceId: string; spanId: string; attributes: object }) => ({
          context: { traceId: l.traceId, spanId: l.spanId },
          attributes: l.attributes,
        })),
      ),
    };
    const got = fromOpenObserve([hit]);
    expect(got[0]).toMatchObject({ kind: 2, parent: confirm.parent, resource: undefined });
    const { summary } = diffSpans([confirm], got);
    expect(summary).toMatchObject({
      attrNameDiff: Object.keys(confirm.attributes).length,
      attrTypeDiff: 1,
      attrStringified: 1,
      linkDiff: 0,
      eventDiff: 0,
      statusDiff: 0,
      resourceDiff: null,
    });
  });

  it('reads ClickHouse rows of the OpenTelemetry schema, with string maps', () => {
    const row = {
      TraceId: confirm.traceId,
      SpanId: confirm.spanId,
      ParentSpanId: confirm.parent,
      SpanName: confirm.name,
      SpanKind: 'Client',
      StatusCode: 'Error',
      StatusMessage: confirm.status.message,
      SpanAttributes: flat(confirm.attributes),
      ResourceAttributes: flat(confirm.resource),
      ScopeName: confirm.scope.name,
      ScopeVersion: confirm.scope.version,
      'Events.Name': confirm.events.map((e: { name: string }) => e.name),
      'Events.Attributes': confirm.events.map((e: { attributes: Record<string, unknown> }) =>
        flat(e.attributes),
      ),
      'Links.TraceId': confirm.links.map((l: { traceId: string }) => l.traceId),
      'Links.SpanId': confirm.links.map((l: { spanId: string }) => l.spanId),
      'Links.Attributes': confirm.links.map((l: { attributes: Record<string, unknown> }) =>
        flat(l.attributes),
      ),
    };
    const { summary } = diffSpans([confirm], fromClickHouse([row]));
    expect(summary).toMatchObject({
      kindDiff: 0,
      statusDiff: 0,
      attrTypeDiff: 1,
      attrStringified: 1,
      eventAttrDiff: 1,
      linkDiff: 0,
      resourceDiff: 1,
      scopeDiff: 0,
    });
  });

  it('reads MLflow spans without a kind as a dropped kind, and strips the tr- prefix of link trace ids', () => {
    const value = (v: unknown) =>
      typeof v === 'number'
        ? { int_value: String(v) }
        : typeof v === 'boolean'
          ? { bool_value: v }
          : { string_value: v };
    const attrs = (o: Record<string, unknown>) => [
      ...Object.entries(o).map(([key, v]) => ({ key, value: value(v) })),
      { key: 'mlflow.traceRequestId', value: { string_value: `tr-${confirm.traceId}` } },
    ];
    const span = {
      trace_id: Buffer.from(confirm.traceId, 'hex').toString('base64'),
      span_id: Buffer.from(confirm.spanId, 'hex').toString('base64'),
      parent_span_id: Buffer.from(confirm.parent, 'hex').toString('base64'),
      name: confirm.name,
      status: { code: 'STATUS_CODE_ERROR', message: confirm.status.message },
      attributes: attrs(confirm.attributes),
      events: confirm.events.map((e: { name: string; attributes: Record<string, unknown> }) => ({
        name: e.name,
        attributes: attrs(e.attributes).slice(0, -1),
      })),
      links: confirm.links.map(
        (l: { traceId: string; spanId: string; attributes: Record<string, unknown> }) => ({
          trace_id: `tr-${l.traceId}`,
          span_id: l.spanId,
          attributes: attrs(l.attributes).slice(0, -1),
        }),
      ),
    };
    const { summary, differences } = diffSpans([confirm], fromMlflow([span]));
    expect(differences).toEqual([
      expect.objectContaining({ check: 'kindDiff', expected: 2, got: undefined }),
    ]);
    expect(summary.linkDiff).toBe(0);
  });

  it('reads Phoenix OTLP spans in snake case, and a span without links as links lost', () => {
    const item = {
      trace_id: confirm.traceId,
      span_id: confirm.spanId,
      parent_span_id: confirm.parent,
      name: confirm.name,
      kind: 'SPAN_KIND_CLIENT',
      status: { code: 2, message: confirm.status.message },
      attributes: confirm.attributes,
      events: confirm.events,
      links: null,
    };
    const { summary } = diffSpans([confirm], fromPhoenix([item]));
    expect(summary).toMatchObject({ kindDiff: 0, attrTypeDiff: 0, eventDiff: 0, linkDiff: 1 });
  });
});
