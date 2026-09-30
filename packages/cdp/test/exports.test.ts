import { expect, it } from 'vitest';
import * as cdpAdapter from '../src/index.js';

// The runtime exports are a public contract: a change here needs a changeset (see AGENTS.md).
it('keeps the runtime exports of @hashspan/cdp', () => {
  expect(Object.keys(cdpAdapter).sort()).toEqual(['CDP_NETWORK_CHAIN_IDS', 'withHashspan']);
});
