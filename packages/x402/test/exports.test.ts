import { expect, it } from 'vitest';
import * as x402Adapter from '../src/index.js';

// The runtime exports are a public contract: a change here needs a changeset (see AGENTS.md).
it('keeps the runtime exports of @hashspan/x402', () => {
  expect(Object.keys(x402Adapter).sort()).toEqual(['withHashspan']);
});
