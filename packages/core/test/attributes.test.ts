import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('attribute keys', () => {
  const keys = Object.entries(core)
    .filter(([name]) => name.startsWith('ATTR_BLOCKCHAIN_'))
    .map(([, value]) => value as string);

  it('live under the blockchain.* namespace', () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(/^blockchain\.[a-z0-9_.]+$/);
  });

  it('are unique', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});
