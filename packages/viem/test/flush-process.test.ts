import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

it('keeps the process alive until flush() resolves, then records what it could not wait for', async () => {
  const { stdout } = await run(
    process.execPath,
    [tsx, '--tsconfig', fixture('tsconfig.json'), fixture('flush-exit.ts')],
    { timeout: 30_000 },
  );
  expect(JSON.parse(stdout.trim())).toEqual({
    flushed: false,
    // The tracked work was settled by the first flush, so a second one has nothing left to wait for.
    drained: true,
    // The receipt was known; only the revert reason was still pending, so the receipt is recorded without it.
    spans: [{ name: 'confirm 8453', status: 'reverted', reason: null }],
  });
}, 40_000);
