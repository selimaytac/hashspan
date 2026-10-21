// The expected column of the dev-node matrix: the vendored execution-apis OpenRPC files (vendor.mjs), loaded as one
// document, and a validator for the JSON Schema keywords they use. A violation names where it is and what kind it is
// (an extra property, a missing one, a type or pattern that does not match), never the value, so a result that holds
// violations holds no hash, time or address of the run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { FILES, VENDOR_DIR } from './vendor.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The keywords the validator implements; a schema with another one is refused, not silently passed. */
export const KEYWORDS = [
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'description',
  'enum',
  'items',
  'maximum',
  'minimum',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'properties',
  'required',
  'title',
  'type',
];

/**
 * The vendored spec as one document: `schemas` (every schema of src/schemas), `methods` (every method of src/eth and
 * src/debug, by name) and `errorGroups` (by group name).
 * @returns {{ schemas: Record<string, any>, methods: Record<string, any>, errorGroups: Record<string, any> }}
 */
export function loadSpec(root = ROOT) {
  const spec = { schemas: {}, methods: {}, errorGroups: {} };
  for (const path of FILES.filter((f) => f.endsWith('.yaml'))) {
    const doc = parse(readFileSync(join(root, VENDOR_DIR, path), 'utf8'));
    if (path.startsWith('src/schemas/')) Object.assign(spec.schemas, doc);
    else if (path.startsWith('src/error-groups/')) Object.assign(spec.errorGroups, doc);
    else for (const method of doc) spec.methods[method.name] = method;
  }
  return spec;
}

const REF = '#/components/schemas/';

/** The schema a `$ref` names. */
function resolve(spec, ref) {
  if (!ref.startsWith(REF)) throw new Error(`unsupported $ref ${ref}`);
  const schema = spec.schemas[ref.slice(REF.length)];
  if (!schema) throw new Error(`unresolved $ref ${ref}`);
  return schema;
}

/** Every `$ref` under a value, for the closure check of the vendored files. */
export function refsOf(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) refsOf(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.add(v);
      else refsOf(v, out);
    }
  }
  return out;
}

/** The JSON type of a value: null, array, object, string, number or boolean. */
export const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};
const isType = (value, type) =>
  type === 'integer' ? Number.isInteger(value) : typeOf(value) === type;

/** The JSON pointer of a path. */
const at = (path) => (path.length ? `/${path.join('/')}` : '/');

/**
 * Validates `value` against `schema`; returns the violations, empty when it matches. Each is `{ path, keyword }`, with
 * `property` for an extra or missing property and `got` for the JSON type found where a type or pattern was expected.
 */
export function validate(spec, schema, value, path = []) {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.includes(key)) throw new Error(`unsupported keyword ${key} at ${at(path)}`);
  }
  if (schema.$ref) return validate(spec, resolve(spec, schema.$ref), value, path);
  const out = [];
  const add = (keyword, extra = {}) => out.push({ path: at(path), keyword, ...extra });
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((t) => isType(value, t))) {
      add('type', { expected: types.join('|'), got: typeOf(value) });
      return out;
    }
  }
  if (schema.const !== undefined && value !== schema.const) add('const');
  if (schema.enum !== undefined && !schema.enum.includes(value)) add('enum');
  if (typeof value === 'string' && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern).test(value)) add('pattern', { expected: schema.pattern });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add('minimum');
    if (schema.maximum !== undefined && value > schema.maximum) add('maximum');
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      out.push(...validate(spec, schema.items, item, [...path, String(i)]));
    });
  }
  if (typeOf(value) === 'object') {
    for (const name of schema.required ?? []) {
      if (!(name in value)) add('required', { property: name });
    }
    const properties = schema.properties ?? {};
    const patterns = Object.entries(schema.patternProperties ?? {});
    for (const [name, v] of Object.entries(value)) {
      if (name in properties) {
        out.push(...validate(spec, properties[name], v, [...path, name]));
        continue;
      }
      const pattern = patterns.find(([p]) => new RegExp(p).test(name));
      if (pattern) out.push(...validate(spec, pattern[1], v, [...path, name]));
      else if (schema.additionalProperties === false) {
        add('additionalProperties', { property: name, got: typeOf(v) });
      } else if (typeof schema.additionalProperties === 'object') {
        out.push(...validate(spec, schema.additionalProperties, v, [...path, name]));
      }
    }
  }
  for (const sub of schema.allOf ?? []) out.push(...validate(spec, sub, value, path));
  if (schema.anyOf && !schema.anyOf.some((s) => validate(spec, s, value, path).length === 0)) {
    out.push(...closest(spec, schema.anyOf, value, path, 'anyOf'));
  }
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((s) => validate(spec, s, value, path).length === 0);
    if (matching.length === 0) out.push(...closest(spec, schema.oneOf, value, path, 'oneOf'));
    else if (matching.length > 1) add('oneOf', { matched: matching.length });
  }
  if (schema.not && validate(spec, schema.not, value, path).length === 0) add('not');
  return out;
}

/**
 * The violations of the alternative that came closest (fewest violations), so a receipt with one extra property under
 * a `oneOf` reports that property rather than only "no alternative matched".
 */
function closest(spec, alternatives, value, path, keyword) {
  // An alternative of another type (null for an object) is farther than any of the value's own type.
  const here = at(path);
  const cost = (v) => (v.some((x) => x.keyword === 'type' && x.path === here) ? 1e6 : v.length);
  let best;
  for (const s of alternatives) {
    const v = validate(spec, s, value, path);
    if (!best || cost(v) < cost(best)) best = v;
  }
  return best.length ? best : [{ path: at(path), keyword }];
}

/** The result schema of a method, or undefined when the vendored spec has no such method. */
export function resultSchema(spec, method) {
  return spec.methods[method]?.result?.schema;
}

/** Validates a method's result; throws for a method the vendored spec lacks. */
export function validateResult(spec, method, result) {
  const schema = resultSchema(spec, method);
  if (!schema) throw new Error(`the vendored spec has no ${method}`);
  return validate(spec, schema, result);
}

/** The error codes the error groups of a method name, or undefined when it names none (the spec is silent). */
export function errorCodes(spec, method) {
  const groups = spec.methods[method]?.['error-groups'];
  if (!groups) return undefined;
  return groups.flatMap((g) => {
    const name = g.$ref.replace('#/components/error-groups/', '');
    const group = spec.errorGroups[name];
    if (!group) throw new Error(`unresolved error group ${name}`);
    return group.errors.map((e) => e.code);
  });
}

/** The errors a method lists itself, such as code 3 for a revert on `eth_call` and `eth_estimateGas`. */
export const methodErrors = (spec, method) => spec.methods[method]?.errors ?? [];
