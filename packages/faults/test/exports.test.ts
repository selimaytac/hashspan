import { expect, it } from 'vitest';
import * as faults from '../src/index.js';

// The runtime exports are a public contract: a change here needs a changeset (see AGENTS.md).
it('keeps the runtime exports of @hashspan/faults', () => {
  expect(Object.keys(faults).sort()).toEqual(['startFaultProxy']);
});
