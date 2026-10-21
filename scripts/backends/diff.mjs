// Compares what a backend returned with what was sent, field by field, on the common span shape of normalize.mjs.
// The rules follow the E7 checker, so its recorded read-backs give the same counts: an empty status message equals
// an absent one, an array is its own type, links compare as a set of trace and span ids, spans the backend returned
// beyond the sent ones are counted apart. Additions: a sent attribute name that is missing but present with its dots
// as underscores counts as renamed (`attrNameDiff`) and is then compared under that name; attributes the backend
// added are counted apart (`attrExtra`); event, link, resource and scope attributes are compared the same way as
// span attributes, and resource and scope only when the backend returned them.

/** Type of an attribute value, with arrays apart from objects. */
export const typeOf = (v) => (Array.isArray(v) ? 'array' : typeof v);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether `got` is `expected` written as a string, which is how string-only stores keep values; OpenObserve writes an
 * array as a JSON array of strings (`["1","2"]`).
 */
const stringified = (expected, got) =>
  typeof got === 'string' &&
  (got === String(expected) ||
    got === JSON.stringify(expected) ||
    (Array.isArray(expected) && got === JSON.stringify(expected.map(String))));

/** The counters of a span diff, all zero. `resource` and `scope` counters are null until something is compared. */
export function emptySummary() {
  return {
    spans: 0,
    missing: 0,
    extraSpans: 0,
    nameDiff: 0,
    kindDiff: 0,
    parentDiff: 0,
    statusDiff: 0,
    attrMissing: 0,
    attrNameDiff: 0,
    attrTypeDiff: 0,
    attrStringified: 0,
    attrValueDiff: 0,
    attrExtra: 0,
    eventDiff: 0,
    eventAttrDiff: 0,
    linkDiff: 0,
    linkAttrDiff: 0,
    resourceDiff: null,
    scopeDiff: null,
  };
}

/**
 * Compares the attributes of one span, event, link, resource or scope. Returns the differences; the counters it
 * touches are those named `${prefix}Missing`, ... for spans, and one `diff` count otherwise.
 */
export function compareAttributes(expected, got) {
  const out = [];
  const received = got ?? {};
  const used = new Set();
  for (const [key, value] of Object.entries(expected ?? {})) {
    let name = key;
    if (!(key in received)) {
      const flat = key.replace(/\./g, '_');
      if (flat !== key && flat in received) {
        name = flat;
        out.push({ check: 'attrNameDiff', key, got: flat });
      } else {
        out.push({ check: 'attrMissing', key });
        continue;
      }
    }
    used.add(name);
    const rv = received[name];
    if (typeOf(rv) !== typeOf(value)) {
      out.push({
        check: 'attrTypeDiff',
        key,
        expected: typeOf(value),
        got: typeOf(rv),
        stringified: stringified(value, rv),
      });
    } else if (!same(rv, value)) {
      out.push({ check: 'attrValueDiff', key, expected: value, got: rv });
    }
  }
  const extra = Object.keys(received).filter((k) => !used.has(k) && !(k in (expected ?? {})));
  for (const key of extra) out.push({ check: 'attrExtra', key });
  return out;
}

/** Sorted `traceId/spanId` of a link list. */
const linkKeys = (links) => (links ?? []).map((l) => `${l.traceId}/${l.spanId}`).sort();

/**
 * Diffs the spans of one trace set. `expected` and `received` are common spans; the result holds the summary counters
 * and one entry per difference, in the order of the expected spans.
 */
export function diffSpans(expected, received) {
  const summary = emptySummary();
  const differences = [];
  const bySpan = new Map(received.map((s) => [s.spanId, s]));
  const add = (span, d) => differences.push({ span: span.name, spanId: span.spanId, ...d });
  for (const e of expected) {
    summary.spans++;
    const r = bySpan.get(e.spanId);
    if (!r) {
      summary.missing++;
      add(e, { check: 'missing' });
      continue;
    }
    if (r.name !== e.name) {
      summary.nameDiff++;
      add(e, { check: 'nameDiff', expected: e.name, got: r.name });
    }
    if (r.kind !== e.kind) {
      summary.kindDiff++;
      add(e, { check: 'kindDiff', expected: e.kind, got: r.kind });
    }
    if ((r.parent ?? null) !== (e.parent ?? null)) {
      summary.parentDiff++;
      add(e, { check: 'parentDiff', expected: e.parent ?? null, got: r.parent ?? null });
    }
    const es = { code: e.status?.code ?? 0, message: e.status?.message || undefined };
    const rs = { code: r.status?.code, message: r.status?.message || undefined };
    if (!same(es, rs)) {
      summary.statusDiff++;
      add(e, { check: 'statusDiff', expected: es, got: rs });
    }
    for (const d of compareAttributes(e.attributes, r.attributes)) {
      summary[d.check]++;
      if (d.check === 'attrTypeDiff' && d.stringified) summary.attrStringified++;
      add(e, d);
    }
    // Events are compared by name, not by position: each carries its own time, and Jaeger returns them in another
    // order than they were sent.
    const byName = (evs) =>
      [...(evs ?? [])].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const names = (evs) => byName(evs).map((x) => x.name);
    if (!same(names(e.events), names(r.events))) {
      summary.eventDiff++;
      add(e, { check: 'eventDiff', expected: names(e.events), got: names(r.events) });
    } else {
      const got = byName(r.events);
      byName(e.events).forEach((ev, i) => {
        const ds = compareAttributes(ev.attributes, got[i].attributes).filter(
          (d) => d.check !== 'attrExtra',
        );
        if (ds.length) {
          summary.eventAttrDiff++;
          add(e, { check: 'eventAttrDiff', event: ev.name, differences: ds });
        }
      });
    }
    if (!same(linkKeys(e.links), linkKeys(r.links))) {
      summary.linkDiff++;
      add(e, { check: 'linkDiff', expected: linkKeys(e.links), got: linkKeys(r.links) });
    } else {
      const byKey = new Map((r.links ?? []).map((l) => [`${l.traceId}/${l.spanId}`, l]));
      for (const l of e.links ?? []) {
        const ds = compareAttributes(
          l.attributes,
          byKey.get(`${l.traceId}/${l.spanId}`)?.attributes,
        ).filter((d) => d.check !== 'attrExtra');
        if (ds.length) {
          summary.linkAttrDiff++;
          add(e, { check: 'linkAttrDiff', link: `${l.traceId}/${l.spanId}`, differences: ds });
        }
      }
    }
    for (const part of ['resource', 'scope']) {
      if (r[part] === undefined || e[part] === undefined) continue;
      const counter = `${part}Diff`;
      summary[counter] ??= 0;
      const ds =
        part === 'resource'
          ? compareAttributes(e.resource, r.resource).filter((d) => d.check !== 'attrExtra')
          : [
              ...(r.scope.name === e.scope.name
                ? []
                : [{ check: 'name', expected: e.scope.name, got: r.scope.name }]),
              ...((r.scope.version ?? undefined) === (e.scope.version ?? undefined)
                ? []
                : [{ check: 'version', expected: e.scope.version, got: r.scope.version }]),
              ...(r.scope.attributes === undefined
                ? []
                : compareAttributes(e.scope.attributes, r.scope.attributes).filter(
                    (d) => d.check !== 'attrExtra',
                  )),
            ];
      if (ds.length) {
        summary[counter]++;
        add(e, { check: counter, differences: ds });
      }
    }
  }
  const known = new Set(expected.map((s) => s.spanId));
  for (const r of received.filter((s) => !known.has(s.spanId))) {
    summary.extraSpans++;
    differences.push({ span: r.name, spanId: r.spanId, check: 'extraSpan' });
  }
  return { summary, differences };
}

/** What the expected spans exercise, so a zero counter is told apart from a check that had nothing to compare. */
export function exercised(expected, received) {
  const types = new Set();
  const collect = (attrs) => {
    for (const v of Object.values(attrs ?? {})) types.add(typeOf(v));
  };
  for (const s of expected) {
    collect(s.attributes);
    for (const e of s.events ?? []) collect(e.attributes);
  }
  return {
    attributeTypes: [...types].sort(),
    statusMessage: expected.some((s) => !!s.status?.message),
    eventAttributes: expected.some((s) =>
      (s.events ?? []).some((e) => Object.keys(e.attributes ?? {}).length),
    ),
    links: expected.reduce((n, s) => n + (s.links?.length ?? 0), 0),
    crossTraceLinks: expected.reduce(
      (n, s) => n + (s.links ?? []).filter((l) => l.traceId !== s.traceId).length,
      0,
    ),
    linkAttributes: expected.some((s) =>
      (s.links ?? []).some((l) => Object.keys(l.attributes ?? {}).length),
    ),
    resource: received.some((s) => s.resource !== undefined),
    scope: received.some((s) => s.scope !== undefined),
  };
}

/**
 * Diffs metric counts: `expected` and `got` map a metric name to `{ count, by: { outcome: count } }`. Returns the
 * metrics whose total or per-outcome counts differ.
 */
export function diffMetrics(expected, got) {
  const differences = [];
  for (const [name, e] of Object.entries(expected)) {
    const g = got?.[name];
    if (!g) {
      differences.push({ metric: name, check: 'missing' });
      continue;
    }
    if (g.count !== e.count)
      differences.push({ metric: name, check: 'count', expected: e.count, got: g.count });
    if (e.by && g.by && !same(sortKeys(e.by), sortKeys(g.by))) {
      differences.push({
        metric: name,
        check: 'outcomes',
        expected: sortKeys(e.by),
        got: sortKeys(g.by),
      });
    }
  }
  return { metrics: Object.keys(expected).length, differences };
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * The differences grouped by check and attribute or event name, sorted, with a count and the span names they occur
 * on: short enough for a result file, and the same on every run.
 */
export function groupDifferences(differences) {
  const groups = new Map();
  for (const d of differences) {
    let detail = d.key ?? d.event;
    if (d.check === 'kindDiff') detail = `${d.expected} -> ${d.got ?? 'none'}`;
    if (d.check === 'attrTypeDiff') detail = `${d.key}: ${d.expected} -> ${d.got}`;
    if (d.check === 'attrNameDiff') detail = `${d.key} -> ${d.got}`;
    const key = `${d.check}|${detail ?? ''}`;
    const g = groups.get(key) ?? {
      check: d.check,
      ...(detail === undefined ? {} : { detail }),
      count: 0,
      spans: new Set(),
    };
    g.count++;
    g.spans.add(d.span);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, spans: [...g.spans].sort() }))
    .sort((a, b) => (`${a.check}|${a.detail ?? ''}` < `${b.check}|${b.detail ?? ''}` ? -1 : 1));
}
