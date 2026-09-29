import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

const doc = readFileSync(new URL('../../../docs/semconv.md', import.meta.url), 'utf8');

/** Attribute names from the first column of the attribute table in docs/semconv.md. */
const documented = new Set(
  [...doc.matchAll(/^\| `([a-z_]+(?:\.[a-z0-9_]+)+)` \| (?:string|int) \|/gm)].map((m) => m[1]),
);
const exported = (prefix: string) =>
  Object.entries(core)
    .filter(([name]) => name.startsWith(prefix))
    .map(([, value]) => value as string);

describe('docs/semconv.md', () => {
  it('documents every exported attribute key in its table', () => {
    const inTable = [...exported('ATTR_BLOCKCHAIN_'), core.ATTR_ERROR_TYPE];
    expect(inTable.filter((key) => !documented.has(key))).toEqual([]);
  });

  it('documents no attribute that is not exported', () => {
    const keys = new Set(exported('ATTR_'));
    expect([...documented].filter((key) => !keys.has(key))).toEqual([]);
  });

  it('describes the GenAI agent attributes', () => {
    for (const key of exported('ATTR_GEN_AI_')) expect(doc).toContain(`\`${key}\``);
  });

  it('lists exactly the exported values of blockchain.tx.status', () => {
    const row = doc.split('\n').find((line) => line.startsWith('| `blockchain.tx.status` |'));
    // Values are the backticked words without a dot; the cells use escaped pipes (\|) as separators.
    const listed = [...(row ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual(exported('BLOCKCHAIN_TX_STATUS_VALUE_').sort());
  });
});
