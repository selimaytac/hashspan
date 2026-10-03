// The viem release the tests run against. CI tests the lockfile's viem, and .github/workflows/viem-range.yml also the
// oldest and the newest release of the peer range; a test that needs behaviour or an action of a newer release than
// the floor is gated here or by feature detection, with a comment naming the release that introduced it.
import { createRequire } from 'node:module';
import * as viemActions from 'viem/actions';

const installed = (createRequire(import.meta.url)('viem/package.json') as { version: string })
  .version;

const parts = (version: string): number[] =>
  version
    .split('-')[0]
    ?.split('.')
    .map((part) => Number(part)) ?? [];

/** Whether the installed viem is `version` or newer. */
export function viemAtLeast(version: string): boolean {
  const have = parts(installed);
  const want = parts(version);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Whether the installed viem exports `action` from `viem/actions`. */
export function viemHasAction(action: string): boolean {
  return typeof (viemActions as Record<string, unknown>)[action] === 'function';
}
