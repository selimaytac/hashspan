// Turns each backend's read-back into one common span shape, the one diff.mjs compares:
//   { traceId, spanId, parent, name, kind, status: { code, message }, attributes, events: [{ name, attributes }],
//     links: [{ traceId, spanId, attributes }], resource, scope: { name, version, attributes } }
// Ids are lower-case hex, `parent` is null for a root, `kind` uses the OTel API numbers (INTERNAL 0, CLIENT 2) and is
// undefined when the backend returns none, and `status.code` uses UNSET 0, OK 1, ERROR 2. `resource` and `scope` are
// undefined when the backend's read-back does not return them, so the diff reports them as not checked, not as lost.
// Values stay as the backend returns them: a number stored as a string stays a string.

const OTLP_KINDS = {
  SPAN_KIND_UNSPECIFIED: undefined,
  SPAN_KIND_INTERNAL: 0,
  SPAN_KIND_SERVER: 1,
  SPAN_KIND_CLIENT: 2,
  SPAN_KIND_PRODUCER: 3,
  SPAN_KIND_CONSUMER: 4,
};
const OTLP_STATUS = { STATUS_CODE_UNSET: 0, STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2 };

/** OTLP JSON AnyValue to a JS value. int64 values, which proto3 JSON may write as strings, become numbers. */
export function anyValue(v) {
  if (v == null) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ('kvlistValue' in v) return keyValues(v.kvlistValue?.values);
  if ('bytesValue' in v) return v.bytesValue;
  return undefined;
}

/** OTLP JSON KeyValue list to an object. */
export const keyValues = (list) =>
  Object.fromEntries((list ?? []).map((a) => [a.key, anyValue(a.value)]));

/** A trace or span id as lower-case hex: OTLP JSON uses hex, some backends base64. */
export function hexId(id) {
  if (id == null || id === '') return undefined;
  if (/^[0-9a-f]+$/i.test(id) && (id.length === 16 || id.length === 32)) return id.toLowerCase();
  return Buffer.from(id, 'base64').toString('hex');
}

/** An OTLP kind (number or enum name) to the OTel API number. */
export function otlpKind(kind) {
  if (typeof kind === 'number') return kind === 0 ? undefined : kind - 1;
  return OTLP_KINDS[kind];
}

/** An OTLP status (number or enum name) to `{ code, message }`. */
export const otlpStatus = (status) => ({
  code: typeof status?.code === 'number' ? status.code : (OTLP_STATUS[status?.code] ?? 0),
  message: status?.message || undefined,
});

/** OTLP JSON `resourceSpans` (Tempo, Jaeger v3, Aspire) to common spans. */
export function fromOtlpJson(resourceSpans) {
  const out = [];
  for (const rs of resourceSpans ?? []) {
    const resource = keyValues(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      const s0 = ss.scope ?? ss.instrumentationLibrary ?? {};
      const scope = {
        name: s0.name,
        version: s0.version || undefined,
        attributes: keyValues(s0.attributes),
      };
      for (const s of ss.spans ?? []) {
        out.push({
          traceId: hexId(s.traceId),
          spanId: hexId(s.spanId),
          parent: hexId(s.parentSpanId) ?? null,
          name: s.name,
          kind: otlpKind(s.kind),
          status: otlpStatus(s.status),
          attributes: keyValues(s.attributes),
          events: (s.events ?? []).map((e) => ({
            name: e.name,
            attributes: keyValues(e.attributes),
          })),
          links: (s.links ?? []).map((l) => ({
            traceId: hexId(l.traceId),
            spanId: hexId(l.spanId),
            attributes: keyValues(l.attributes),
          })),
          resource,
          scope,
        });
      }
    }
  }
  return out;
}

const OO_CORE = new Set([
  '_o2_ingest_ts',
  '_timestamp',
  'duration',
  'end_time',
  'events',
  'flags',
  'links',
  'operation_name',
  'span_id',
  'span_kind',
  'span_status',
  'start_time',
  'status_code',
  'status_message',
  'trace_id',
]);

/**
 * OpenObserve `_search?type=traces` hits. Span attributes are the remaining columns, with the names and values as
 * OpenObserve stores them; `reference_*` columns hold the parent, `service_*` columns the resource, which is left
 * unread because they cannot be told from flattened span attributes.
 */
export function fromOpenObserve(hits) {
  return (hits ?? []).map((h) => ({
    traceId: hexId(h.trace_id),
    spanId: hexId(h.span_id),
    parent: hexId(h.reference_parent_span_id) ?? null,
    name: h.operation_name,
    kind: Number(h.span_kind) ? Number(h.span_kind) - 1 : undefined,
    status: { code: Number(h.status_code ?? 0), message: h.status_message || undefined },
    attributes: Object.fromEntries(
      Object.entries(h).filter(
        ([k]) => !OO_CORE.has(k) && !k.startsWith('reference_') && !k.startsWith('service_'),
      ),
    ),
    events: JSON.parse(h.events || '[]').map(({ name, _timestamp, ...attributes }) => ({
      name,
      attributes,
    })),
    links: JSON.parse(h.links || '[]').map((l) => ({
      traceId: hexId(l.context?.traceId),
      spanId: hexId(l.context?.spanId),
      attributes: l.attributes ?? {},
    })),
    resource: undefined,
    scope: undefined,
  }));
}

const CH_KINDS = { Internal: 0, Server: 1, Client: 2, Producer: 3, Consumer: 4 };
const CH_STATUS = { Unset: 0, Ok: 1, Error: 2 };

/** HyperDX local (ClickHouse `default.otel_traces`, the OpenTelemetry Collector's exporter schema) rows. */
export function fromClickHouse(rows) {
  return (rows ?? []).map((r) => ({
    traceId: hexId(r.TraceId),
    spanId: hexId(r.SpanId),
    parent: hexId(r.ParentSpanId) ?? null,
    name: r.SpanName,
    kind: CH_KINDS[r.SpanKind],
    status: { code: CH_STATUS[r.StatusCode] ?? 0, message: r.StatusMessage || undefined },
    attributes: r.SpanAttributes ?? {},
    events: (r['Events.Name'] ?? []).map((name, i) => ({
      name,
      attributes: r['Events.Attributes']?.[i] ?? {},
    })),
    links: (r['Links.TraceId'] ?? []).map((t, i) => ({
      traceId: hexId(t),
      spanId: hexId(r['Links.SpanId']?.[i]),
      attributes: r['Links.Attributes']?.[i] ?? {},
    })),
    resource: r.ResourceAttributes,
    scope:
      r.ScopeName === undefined
        ? undefined
        : { name: r.ScopeName, version: r.ScopeVersion || undefined, attributes: undefined },
  }));
}

/** MLflow AnyValue (snake case) to a JS value. */
function mlflowValue(v) {
  if (v == null) return undefined;
  if ('string_value' in v) return v.string_value;
  if ('int_value' in v) return Number(v.int_value);
  if ('double_value' in v) return Number(v.double_value);
  if ('bool_value' in v) return v.bool_value;
  if ('array_value' in v) return (v.array_value?.values ?? []).map(mlflowValue);
  return undefined;
}
// MLflow adds its own request id to every span; it is not part of what was sent.
const mlflowAttributes = (list) =>
  Object.fromEntries(
    (list ?? [])
      .map((a) => [a.key, mlflowValue(a.value)])
      .filter(([k]) => k !== 'mlflow.traceRequestId'),
  );

/** MLflow 3 REST `traces/batchGet` spans. The trace id is the OTLP one, as MLflow writes it with a `tr-` prefix. */
export function fromMlflow(spans) {
  return (spans ?? []).map((s) => ({
    traceId: hexId(s.trace_id),
    spanId: hexId(s.span_id),
    parent: hexId(s.parent_span_id) ?? null,
    name: s.name,
    kind: s.kind === undefined ? undefined : otlpKind(s.kind),
    status: otlpStatus(s.status),
    attributes: mlflowAttributes(s.attributes),
    events: (s.events ?? []).map((e) => ({
      name: e.name,
      attributes: mlflowAttributes(e.attributes),
    })),
    links: (s.links ?? []).map((l) => ({
      traceId: hexId(String(l.trace_id ?? '').replace(/^tr-/, '')),
      spanId: hexId(l.span_id),
      attributes: mlflowAttributes(l.attributes),
    })),
    resource: undefined,
    scope: undefined,
  }));
}

/**
 * Phoenix `/v1/projects/{project}/spans/otlpv1` items: OTLP spans in JSON, in camel or snake case. Untested until the
 * first run against Phoenix.
 */
export function fromPhoenix(items) {
  const attrs = (a) => (Array.isArray(a) ? keyValues(a) : (a ?? {}));
  return (items ?? []).map((s) => ({
    traceId: hexId(s.traceId ?? s.trace_id),
    spanId: hexId(s.spanId ?? s.span_id),
    parent: hexId(s.parentSpanId ?? s.parent_span_id) ?? null,
    name: s.name,
    kind: otlpKind(s.kind),
    status: otlpStatus(s.status),
    attributes: attrs(s.attributes),
    events: (s.events ?? []).map((e) => ({ name: e.name, attributes: attrs(e.attributes) })),
    links: (s.links ?? []).map((l) => ({
      traceId: hexId(l.traceId ?? l.trace_id),
      spanId: hexId(l.spanId ?? l.span_id),
      attributes: attrs(l.attributes),
    })),
    resource: undefined,
    scope: undefined,
  }));
}
