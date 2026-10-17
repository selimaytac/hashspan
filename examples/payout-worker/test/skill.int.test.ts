// skills/hashspan/SKILL.md applied to the payout worker before hashspan (test/skill-fixture/), a service that never
// waits for receipts, then run on Anvil and stopped with SIGTERM: the skill's background confirmation and signal
// handlers must deliver a send and a confirm span under each job span.
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applySkill,
  outcome,
  runProject,
  startReceiver,
} from '../../../packages/viem/test/apply-skill.js';
import { type StartedAnvil, startAnvil } from '../../../packages/viem/test/start-anvil.js';

let anvil: StartedAnvil;
let receiver: Awaited<ReturnType<typeof startReceiver>>;

beforeAll(async () => {
  anvil = await startAnvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  });
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver?.close();
  await anvil?.instance.stop();
});

it('gives each payout job a send and a confirm span once the service is stopped', async () => {
  const entry = applySkill({
    fixture: fileURLToPath(new URL('./skill-fixture/', import.meta.url)),
    entry: 'main.ts',
    serviceName: 'payout-worker',
    kind: 'service',
  });
  try {
    const child = runProject(entry, receiver.endpoint, anvil.rpcUrl);
    const done = outcome(child);
    // Stopped once it waits for more payouts, as a deployment stops a service.
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('waiting for payouts')) resolve();
      });
      child.on('close', () => reject(new Error('the worker exited before it was stopped')));
    });
    child.kill('SIGTERM');
    const { code, stderr } = await done;
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  } finally {
    rmSync(dirname(entry), { recursive: true, force: true });
  }

  const { spans } = receiver;
  expect(new Set(spans.map((span) => span.service))).toEqual(new Set(['payout-worker']));
  const jobs = spans.filter((span) => span.name.startsWith('payout '));
  expect(jobs.map((job) => job.name).sort()).toEqual(['payout po-1', 'payout po-2']);
  for (const job of jobs) {
    const children = spans.filter((span) => span.parentSpanId === job.spanId);
    expect(children.map((span) => span.name).sort()).toEqual(['confirm 31337', 'send 31337']);
  }
}, 90_000);
