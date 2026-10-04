import { expect, it } from 'vitest';
import { DEFAULT_BACKGROUND_TIMEOUT_MS } from '../../viem/src/confirm/confirmation.js';
import { DEFAULT_FLUSH_TIMEOUT_MS as VIEM_FLUSH_TIMEOUT_MS } from '../../viem/src/confirm/pending.js';
import { DEFAULT_CONFIRM_TIMEOUT_MS, DEFAULT_FLUSH_TIMEOUT_MS } from '../src/helpers.js';

// The cdp adapter documents the same flush and confirmation defaults as @hashspan/viem; the two packages do not share
// a public constant for them, so this keeps the copies equal.
it('has the flush and confirmation defaults of @hashspan/viem', () => {
  expect(DEFAULT_FLUSH_TIMEOUT_MS).toBe(VIEM_FLUSH_TIMEOUT_MS);
  expect(DEFAULT_CONFIRM_TIMEOUT_MS).toBe(DEFAULT_BACKGROUND_TIMEOUT_MS);
});
