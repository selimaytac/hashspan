// What a test recorded, checked against the semantic conventions as @hashspan/core exports them: `ATTR_*` are the
// attribute keys, `METRIC_*` the metric names and `BLOCKCHAIN_<NAME>_VALUE_<VALUE>` the closed set of values of
// `ATTR_BLOCKCHAIN_<NAME>`. Nothing here copies docs/semconv.md, so a stray or renamed attribute fails a test at PR
// time. The test tracing setups of the packages run it on every span when they tear down.
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as core from '../src/index.js';

/** The namespaces hashspan owns: an attribute in one of them must be in the conventions. */
const OWNED_PREFIXES = ['blockchain.', 'x402.'] as const;

export interface Contract {
  /** Attribute keys, such as `blockchain.tx.hash`. */
  attributes: ReadonlySet<string>;
  /** Metric names, such as `blockchain.client.fee`. */
  metrics: ReadonlySet<string>;
  /** The documented values of each attribute that has a closed set. */
  values: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The conventions as `exports` (a module namespace of @hashspan/core) define them. */
export function readContract(exports: Record<string, unknown>): Contract {
  const attributes = new Set<string>();
  const metrics = new Set<string>();
  const byConstant = new Map<string, string>();
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== 'string') continue;
    if (name.startsWith('ATTR_')) {
      attributes.add(value);
      byConstant.set(name, value);
    } else if (name.startsWith('METRIC_')) {
      metrics.add(value);
    }
  }
  const values = new Map<string, Set<string>>();
  for (const [name, value] of Object.entries(exports)) {
    const match = /^BLOCKCHAIN_(.+)_VALUE_.+$/.exec(name);
    const attribute = match && byConstant.get(`ATTR_BLOCKCHAIN_${match[1]}`);
    if (typeof value !== 'string' || !attribute) continue;
    const set = values.get(attribute) ?? new Set<string>();
    set.add(value);
    values.set(attribute, set);
  }
  return { attributes, metrics, values };
}

/** The conventions of the core under test. */
export const CONTRACT: Contract = readContract(core as unknown as Record<string, unknown>);

const owned = (key: string): boolean => OWNED_PREFIXES.some((prefix) => key.startsWith(prefix));

function attributeViolations(attributes: Attributes, where: string, contract: Contract): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (owned(key) && !contract.attributes.has(key)) {
      violations.push(`${where}${key} is not in the semantic conventions`);
      continue;
    }
    const allowed = contract.values.get(key);
    if (allowed && !(typeof value === 'string' && allowed.has(value))) {
      violations.push(
        `${where}${key} is ${JSON.stringify(value)}, not one of ${[...allowed].sort().join(', ')}`,
      );
    }
  }
  return violations;
}

/** What `spans` (their attributes and their events' attributes) record outside the conventions. */
export function spanViolations(
  spans: readonly ReadableSpan[],
  contract: Contract = CONTRACT,
): string[] {
  return spans.flatMap((span) => [
    ...attributeViolations(span.attributes, `span "${span.name}": `, contract),
    ...span.events.flatMap((event) =>
      attributeViolations(
        event.attributes ?? {},
        `span "${span.name}" event ${event.name}: `,
        contract,
      ),
    ),
  ]);
}

/** What metric samples record outside the conventions: an unknown metric name, label or label value. */
export function metricViolations(
  samples: readonly { name: string; attributes: Attributes }[],
  contract: Contract = CONTRACT,
): string[] {
  return samples.flatMap(({ name, attributes }) => [
    ...(contract.metrics.has(name) ? [] : [`metric ${name} is not in the semantic conventions`]),
    ...attributeViolations(attributes, `metric ${name}: `, contract),
  ]);
}

/** Throws when `spans` record anything outside the conventions; for the teardown of a test tracing setup. */
export function assertConformant(spans: readonly ReadableSpan[]): void {
  const violations = spanViolations(spans);
  if (violations.length > 0) {
    throw new Error(`recorded outside the semantic conventions:\n  ${violations.join('\n  ')}`);
  }
}
