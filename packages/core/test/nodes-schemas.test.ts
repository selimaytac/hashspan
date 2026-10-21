// Tests the expected column of the dev-node matrix (scripts/nodes/) without a node: the vendored execution-apis files
// are exactly the pinned list, byte for byte as the manifest records them at the pinned commit, every reference in them
// resolves, and the validator reports what a schema violation is without the value.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  errorCodes,
  KEYWORDS,
  loadSpec,
  methodErrors,
  refsOf,
  validate,
  validateResult,
} from '../../../scripts/nodes/schemas.mjs';
import {
  FILES,
  gitBlob,
  MANIFEST,
  manifestOf,
  readVendored,
  SOURCE,
  sha256,
  VENDOR_DIR,
} from '../../../scripts/nodes/vendor.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, VENDOR_DIR);
const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
const spec = loadSpec(root);

/** Every file under a directory, relative to it. */
const filesUnder = (base: string, at = base): string[] =>
  readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    return statSync(path).isDirectory() ? filesUnder(base, path) : [relative(base, path)];
  });

const receipt = () => ({
  type: '0x2',
  status: '0x1',
  cumulativeGasUsed: '0x5208',
  logs: [],
  logsBloom: `0x${'0'.repeat(512)}`,
  transactionHash: `0x${'a'.repeat(64)}`,
  transactionIndex: '0x0',
  blockHash: `0x${'b'.repeat(64)}`,
  blockNumber: '0x1',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x77359400',
  from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  to: '0x000000000000000000000000000000000000dEaD',
  contractAddress: null,
});

describe('vendored execution-apis files', () => {
  it('come from the pinned commit of execution-apis, CC0-1.0', () => {
    expect(SOURCE).toEqual({
      repo: 'https://github.com/ethereum/execution-apis',
      commit: '16caee274b0d4fb7a0316f294029adac88a75a09',
      license: 'CC0-1.0',
    });
    expect(manifest.source).toEqual(SOURCE);
    expect(readVendored(root, 'LICENSE').toString().split('\n')[0]).toBe('CC0 1.0 Universal');
  });

  it('are exactly the pinned file list, with the manifest and nothing else', () => {
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(FILES);
    expect(filesUnder(dir).sort()).toEqual([...FILES, MANIFEST].sort());
    // Only method files, schemas and error groups: no markdown (its links are not this repository's) and no fixtures.
    for (const path of FILES.filter((f) => f !== 'LICENSE')) {
      expect(path).toMatch(/^src\/(eth|debug|schemas|error-groups)\/[a-z_-]+\.yaml$/);
    }
  });

  it.each(FILES)('%s has the bytes the manifest records (git blob and SHA-256)', (path) => {
    const bytes = readVendored(root, path);
    const entry = manifest.files.find((f: { path: string }) => f.path === path);
    expect(gitBlob(bytes)).toBe(entry.gitBlob);
    expect(sha256(bytes)).toBe(entry.sha256);
  });

  it('has the manifest the vendoring script writes for these bytes', () => {
    const files = Object.fromEntries(FILES.map((path) => [path, readVendored(root, path)]));
    expect(manifestOf(files)).toEqual(manifest);
    // The blob id is the one git computes, so it can be compared with the commit's tree.
    expect(gitBlob(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('resolves every schema reference within the vendored files', () => {
    const refs = [...refsOf(spec)].filter((r) => r.startsWith('#/components/schemas/'));
    expect(refs.length).toBeGreaterThan(50);
    const missing = refs.filter((r) => !(r.slice('#/components/schemas/'.length) in spec.schemas));
    expect(missing).toEqual([]);
    for (const ref of refsOf(spec)) {
      expect(ref).toMatch(/^#\/components\/(schemas|error-groups)\//);
    }
  });

  it('has a result schema for every method the flows validate', () => {
    for (const method of [
      'eth_getTransactionReceipt',
      'eth_getBlockReceipts',
      'eth_feeHistory',
      'eth_getLogs',
      'eth_newFilter',
      'eth_getFilterLogs',
      'eth_uninstallFilter',
      'eth_estimateGas',
      'eth_simulateV1',
      'eth_sendRawTransaction',
      'debug_traceTransaction',
    ]) {
      expect({ method, has: spec.methods[method]?.result?.schema !== undefined }).toEqual({
        method,
        has: true,
      });
    }
  });

  it('uses only the keywords the validator implements', () => {
    const used = new Set<string>();
    const walk = (schema: unknown): void => {
      if (Array.isArray(schema)) {
        for (const item of schema) walk(item);
        return;
      }
      if (!schema || typeof schema !== 'object') return;
      for (const [key, value] of Object.entries(schema)) {
        used.add(key);
        if (key === 'properties' || key === 'patternProperties') Object.values(value).forEach(walk);
        else if (!['title', 'description', 'pattern', 'enum', 'const', 'required'].includes(key))
          walk(value);
      }
    };
    Object.values(spec.schemas).forEach(walk);
    for (const method of Object.values(spec.methods) as { result?: { schema?: unknown } }[]) {
      walk(method.result?.schema);
    }
    expect([...used].filter((k) => !KEYWORDS.includes(k))).toEqual([]);
  });
});

describe('schema validation', () => {
  it('passes a receipt of the spec and a fee history of the spec', () => {
    expect(validateResult(spec, 'eth_getTransactionReceipt', receipt())).toEqual([]);
    expect(validateResult(spec, 'eth_getTransactionReceipt', null)).toEqual([]);
    expect(
      validateResult(spec, 'eth_feeHistory', {
        oldestBlock: '0x0',
        baseFeePerGas: ['0x3b9aca00', '0x342a1c58'],
        gasUsedRatio: [0.0007],
        baseFeePerBlobGas: ['0x1', '0x1'],
        blobGasUsedRatio: [0],
        reward: [['0x0', '0x0']],
      }),
    ).toEqual([]);
  });

  it('names an extra property, with its JSON type and never its value', () => {
    const violations = validateResult(spec, 'eth_getTransactionReceipt', {
      ...receipt(),
      blockTimestamp: 1792593373,
    });
    expect(violations).toEqual([
      { path: '/', keyword: 'additionalProperties', property: 'blockTimestamp', got: 'number' },
    ]);
    expect(JSON.stringify(violations)).not.toContain('1792593373');
  });

  it('names a missing required property, a wrong type and a pattern mismatch', () => {
    const { effectiveGasPrice: _, ...withoutPrice } = receipt();
    expect(validateResult(spec, 'eth_getTransactionReceipt', withoutPrice)).toEqual([
      { path: '/', keyword: 'required', property: 'effectiveGasPrice' },
    ]);
    expect(
      validateResult(spec, 'eth_getTransactionReceipt', { ...receipt(), gasUsed: 21000 }),
    ).toEqual([{ path: '/gasUsed', keyword: 'type', expected: 'string', got: 'number' }]);
    // A leading zero is not a quantity.
    expect(
      validateResult(spec, 'eth_getTransactionReceipt', { ...receipt(), status: '0x01' }),
    ).toEqual([{ path: '/status', keyword: 'pattern', expected: '^0x(0|[1-9a-f][0-9a-f]*)$' }]);
  });

  it('checks each receipt of a list and the logs inside a receipt', () => {
    const log = {
      address: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
      topics: [`0x${'c'.repeat(64)}`],
      data: '0x',
      blockNumber: '0x1',
      transactionHash: `0x${'a'.repeat(64)}`,
      transactionIndex: '0x0',
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: '0x0',
      removed: false,
      extra: 'x',
    };
    expect(
      validateResult(spec, 'eth_getBlockReceipts', [receipt(), { ...receipt(), logs: [log] }]),
    ).toEqual([
      { path: '/1/logs/0', keyword: 'additionalProperties', property: 'extra', got: 'string' },
    ]);
  });

  it('refuses a keyword it does not implement, rather than passing it', () => {
    expect(() => validate(spec, { type: 'string', format: 'date' }, 'x')).toThrow('format');
    expect(() => validate(spec, { $ref: '#/components/schemas/Nope' }, 'x')).toThrow('unresolved');
    expect(() => validateResult(spec, 'eth_nope', 1)).toThrow('eth_nope');
  });

  it('reads the error codes a method names: the groups of a send, the revert of a call', () => {
    const send = errorCodes(spec, 'eth_sendRawTransaction');
    expect(send).toEqual(
      expect.arrayContaining([-32601, -32602, -32000, -32003, -32004, 1, 3, 802, 1000]),
    );
    expect(errorCodes(spec, 'eth_call')).toBeUndefined();
    expect(methodErrors(spec, 'eth_call')).toEqual([
      expect.objectContaining({ code: 3, message: 'execution reverted' }),
    ]);
    expect(methodErrors(spec, 'eth_estimateGas')).toEqual([expect.objectContaining({ code: 3 })]);
  });
});
