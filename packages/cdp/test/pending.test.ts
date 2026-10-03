import { afterEach, expect, it } from 'vitest';
import { createPending } from '../src/pending.js';

// Tracked work must never surface as an unhandled rejection in the user's process, even if it rejects
// (ADR 0025, rule 1); flush() still resolves once it settled.

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
process.on('unhandledRejection', onUnhandled);
afterEach(() => {
  unhandled.length = 0;
});

it('keeps a rejecting piece of work from becoming an unhandled rejection', async () => {
  const { track, flushOwn } = createPending();
  track(Promise.reject(new Error('boom')));
  expect(await flushOwn(1_000)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(unhandled).toEqual([]);
});
