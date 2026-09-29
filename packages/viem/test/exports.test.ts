import { expect, it } from 'vitest';
import * as viemAdapter from '../src/index.js';

// The runtime exports are a public contract: a change here needs a changeset (see AGENTS.md).
it('keeps the runtime exports of @hashspan/viem', () => {
  expect(Object.keys(viemAdapter).sort()).toEqual(['withHashspan']);
});
