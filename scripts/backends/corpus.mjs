// The fixed trace and metric set the backend matrix sends to each backend. It is data, not produced live by hashspan,
// so a difference in the results is always the backend's. Ids derive from the corpus id, the transport and the span's
// key, so they are the same on every run and differ between the transports sent to one backend; timestamps are
// offsets from the send time, since some backends drop or hide data far from the present.
import { createHash } from 'node:crypto';

/** Version of the corpus below. Change it with any change to the data, since results name it. */
export const CORPUS_ID = 'synthetic-1';

/** OTel API span kinds; OTLP numbers them one higher. */
export const KIND = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
/** OTel API status codes, the same numbers as in OTLP. */
export const STATUS = { UNSET: 0, OK: 1, ERROR: 2 };

const LONG = 'x'.repeat(4096);
const NON_ASCII = 'ödeme onaylandı: 支払い完了 ✓ 🚀';

export const RESOURCE = {
  'service.name': 'hashspan-backend-matrix',
  'service.namespace': 'hashspan',
  'service.version': '1.0.0',
  'corpus.resource.count': 3,
  'corpus.resource.enabled': true,
};

/** The instance id of a transport's copy, which tells the copies' metrics apart in one backend. */
export const instanceIdOf = (transport) => `corpus-${transport.replace('http/', '')}`;

/** The resource attributes of a transport's copy. */
export const resourceOf = (transport) => ({
  ...RESOURCE,
  'service.instance.id': instanceIdOf(transport),
});

export const SCOPES = {
  app: { name: 'hashspan-corpus', version: '1.0.0', attributes: { 'corpus.scope.role': 'app' } },
  rpc: { name: 'hashspan-corpus-rpc', version: '0.1.0', attributes: {} },
};

/**
 * The spans. `trace` and `key` make the ids; `parent` and link `span` name keys of the same corpus. `start` and `end`
 * are milliseconds after the send time.
 */
export const SPANS = [
  { trace: 'a', key: 'root', name: 'corpus root', kind: KIND.INTERNAL, start: 0, end: 900 },
  {
    trace: 'a',
    key: 'send',
    parent: 'root',
    name: 'send 31337',
    kind: KIND.CLIENT,
    start: 10,
    end: 120,
    status: { code: STATUS.OK },
    attributes: {
      'blockchain.system.name': 'evm',
      'blockchain.chain.id': 31337,
      'blockchain.operation.name': 'send',
      'blockchain.tx.value': '1000000000000000000',
      'corpus.double': 1.5,
      'corpus.bool': true,
      'corpus.bool.false': false,
      'corpus.int.negative': -7,
      'corpus.array.string': ['a', 'b', 'c'],
      'corpus.array.int': [1, 2, 3],
      'corpus.array.bool': [true, false],
      'corpus.long': LONG,
      'corpus.non_ascii': NON_ASCII,
    },
  },
  {
    trace: 'a',
    key: 'rpc',
    parent: 'send',
    scope: 'rpc',
    name: 'eth_sendRawTransaction',
    kind: KIND.CLIENT,
    start: 20,
    end: 110,
    attributes: {
      'rpc.system.name': 'jsonrpc',
      'rpc.method': 'eth_sendRawTransaction',
      'server.address': '127.0.0.1',
      'server.port': 8545,
    },
  },
  {
    trace: 'a',
    key: 'confirm',
    parent: 'root',
    name: 'confirm 31337',
    kind: KIND.CLIENT,
    start: 130,
    end: 800,
    status: { code: STATUS.ERROR, message: 'execution reverted: boom' },
    attributes: {
      'blockchain.operation.name': 'confirm',
      'blockchain.tx.status': 'reverted',
      'blockchain.block.number': 12,
      'error.type': 'reverted',
    },
    events: [
      {
        name: 'receipt',
        at: 700,
        attributes: {
          'corpus.event.block': 12,
          'corpus.event.success': false,
          'corpus.event.ratio': 0.25,
        },
      },
      {
        name: 'exception',
        at: 790,
        attributes: {
          'exception.type': 'ContractFunctionRevertedError',
          'exception.message': 'boom',
        },
      },
    ],
    links: [{ trace: 'a', span: 'send', attributes: { 'corpus.link.role': 'send' } }],
  },
  {
    trace: 'a',
    key: 'server',
    parent: 'root',
    name: 'corpus handler',
    kind: KIND.SERVER,
    start: 810,
    end: 850,
  },
  {
    trace: 'a',
    key: 'producer',
    parent: 'server',
    name: 'corpus publish',
    kind: KIND.PRODUCER,
    start: 815,
    end: 820,
  },
  {
    trace: 'a',
    key: 'consumer',
    parent: 'producer',
    name: 'corpus process',
    kind: KIND.CONSUMER,
    start: 825,
    end: 845,
  },
  { trace: 'b', key: 'root', name: 'corpus watch', kind: KIND.INTERNAL, start: 1000, end: 1500 },
  {
    trace: 'b',
    key: 'confirm',
    parent: 'root',
    name: 'confirm 31337',
    kind: KIND.CLIENT,
    start: 1010,
    end: 1400,
    status: { code: STATUS.OK },
    attributes: { 'blockchain.operation.name': 'confirm', 'blockchain.tx.status': 'success' },
    links: [{ trace: 'a', span: 'send', attributes: {} }],
  },
  {
    trace: 'b',
    key: 'fan-in',
    parent: 'root',
    name: 'corpus fan-in',
    kind: KIND.INTERNAL,
    start: 1410,
    end: 1490,
    links: ['root', 'send', 'rpc', 'confirm', 'server', 'producer', 'consumer'].map((span, i) => ({
      trace: 'a',
      span,
      attributes: { 'corpus.link.index': i },
    })),
  },
];

/** The three hashspan histograms (docs/semconv.md, Metrics), one cumulative point per outcome. */
export const METRICS = [
  {
    name: 'blockchain.client.send.duration',
    unit: 's',
    boundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
    points: [
      {
        attributes: { 'blockchain.system.name': 'evm', 'blockchain.chain.id': 31337 },
        values: [0.11, 0.3, 0.4],
      },
      {
        attributes: {
          'blockchain.system.name': 'evm',
          'blockchain.chain.id': 31337,
          'error.type': 'TransactionExecutionError',
        },
        values: [0.02],
      },
    ],
  },
  {
    name: 'blockchain.client.confirmation.duration',
    unit: 's',
    boundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
    points: [
      {
        attributes: {
          'blockchain.system.name': 'evm',
          'blockchain.chain.id': 31337,
          'blockchain.tx.status': 'success',
        },
        values: [0.39, 1.2],
      },
      {
        attributes: {
          'blockchain.system.name': 'evm',
          'blockchain.chain.id': 31337,
          'blockchain.tx.status': 'reverted',
        },
        values: [0.67],
      },
    ],
  },
  {
    name: 'blockchain.client.fee',
    unit: '{wei}',
    boundaries: Array.from({ length: 11 }, (_, i) => 10 ** (i + 8)),
    points: [
      {
        attributes: {
          'blockchain.system.name': 'evm',
          'blockchain.chain.id': 31337,
          'blockchain.tx.status': 'success',
        },
        values: [42000000000000, 63000000000000],
      },
      {
        attributes: {
          'blockchain.system.name': 'evm',
          'blockchain.chain.id': 31337,
          'blockchain.tx.status': 'reverted',
        },
        values: [21000000000000],
      },
    ],
  },
];

/** The transports the corpus can be sent over; each gets its own ids. */
export const TRANSPORTS = ['http/protobuf', 'http/json'];

/** sha256 of the corpus data, so a result names exactly what was sent. */
export function corpusHash() {
  const data = JSON.stringify({ CORPUS_ID, RESOURCE, SCOPES, SPANS, METRICS });
  return createHash('sha256').update(data).digest('hex');
}

const idFor = (transport, ...parts) =>
  createHash('sha256')
    .update([CORPUS_ID, transport, ...parts].join('/'))
    .digest('hex');

/** Trace id (32 hex digits) of a corpus trace for a transport. */
export const traceIdOf = (transport, trace) => idFor(transport, 'trace', trace).slice(0, 32);
/** Span id (16 hex digits) of a corpus span for a transport. */
export const spanIdOf = (transport, trace, key) =>
  idFor(transport, 'span', trace, key).slice(0, 16);

/**
 * Milliseconds since the epoch as an OTel HrTime.
 * @type {(ms: number) => [number, number]}
 */
const hrTime = (ms) => [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];

/**
 * The corpus as ReadableSpan-shaped objects for `@opentelemetry/otlp-transformer`, with `sendTime` (milliseconds since
 * the epoch) as offset zero.
 */
export function readableSpans(transport, sendTime) {
  if (!TRANSPORTS.includes(transport)) throw new Error(`unknown transport ${transport}`);
  const resource = { attributes: resourceOf(transport) };
  const scopes = Object.fromEntries(Object.entries(SCOPES).map(([k, s]) => [k, { ...s }]));
  return SPANS.map((s) => {
    const context = {
      traceId: traceIdOf(transport, s.trace),
      spanId: spanIdOf(transport, s.trace, s.key),
      traceFlags: 1,
    };
    return {
      name: s.name,
      kind: s.kind,
      spanContext: () => context,
      parentSpanContext: s.parent
        ? {
            traceId: context.traceId,
            spanId: spanIdOf(transport, s.trace, s.parent),
            traceFlags: 1,
            isRemote: false,
          }
        : undefined,
      startTime: hrTime(sendTime + s.start),
      endTime: hrTime(sendTime + s.end),
      duration: hrTime(s.end - s.start),
      ended: true,
      status: s.status ?? { code: STATUS.UNSET },
      attributes: s.attributes ?? {},
      events: (s.events ?? []).map((e) => ({
        name: e.name,
        time: hrTime(sendTime + e.at),
        attributes: e.attributes,
      })),
      links: (s.links ?? []).map((l) => ({
        context: {
          traceId: traceIdOf(transport, l.trace),
          spanId: spanIdOf(transport, l.trace, l.span),
          traceFlags: 1,
          isRemote: false,
        },
        attributes: l.attributes,
      })),
      resource,
      instrumentationScope: scopes[s.scope ?? 'app'],
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  });
}

/** The trace ids a transport's copy of the corpus uses, by corpus trace key. */
export function traceIds(transport) {
  return Object.fromEntries(
    [...new Set(SPANS.map((s) => s.trace))].map((t) => [t, traceIdOf(transport, t)]),
  );
}

/** Histogram point value of a list of samples, for explicit bucket boundaries. */
function histogram(values, boundaries) {
  const counts = new Array(boundaries.length + 1).fill(0);
  for (const v of values) {
    const i = boundaries.findIndex((b) => v <= b);
    counts[i === -1 ? boundaries.length : i] += 1;
  }
  return {
    buckets: { boundaries, counts },
    count: values.length,
    sum: values.reduce((a, b) => a + b, 0),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * The metrics as a ResourceMetrics-shaped object for `@opentelemetry/otlp-transformer`: cumulative histograms that
 * started a second before `sendTime`. The numbers are sdk-metrics' `DataPointType.HISTOGRAM` (0),
 * `AggregationTemporality.CUMULATIVE` (1) and `ValueType.DOUBLE` (1).
 */
export function resourceMetrics(transport, sendTime) {
  return {
    resource: { attributes: resourceOf(transport) },
    scopeMetrics: [
      {
        scope: { name: SCOPES.app.name, version: SCOPES.app.version },
        metrics: METRICS.map((m) => ({
          descriptor: { name: m.name, description: '', unit: m.unit, valueType: 1 },
          aggregationTemporality: 1,
          dataPointType: 0,
          dataPoints: m.points.map((p) => ({
            attributes: p.attributes,
            startTime: hrTime(sendTime - 1000),
            endTime: hrTime(sendTime),
            value: histogram(p.values, m.boundaries),
          })),
        })),
      },
    ],
  };
}

/** What a backend should hold for the metrics: the count per metric and outcome (`none` for a sample without one). */
export function expectedMetricCounts() {
  return Object.fromEntries(
    METRICS.map((m) => {
      const by = {};
      for (const p of m.points) {
        const key = outcomeOf(p.attributes);
        by[key] = (by[key] ?? 0) + p.values.length;
      }
      return [m.name, { count: m.points.reduce((a, p) => a + p.values.length, 0), by }];
    }),
  );
}

/** The outcome a metric sample is counted under. */
export const outcomeOf = (attributes) =>
  String(attributes['blockchain.tx.status'] ?? attributes['error.type'] ?? 'none');
