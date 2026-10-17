// skills/hashspan/SKILL.md applied to the treasury agent before hashspan (test/skill-fixture/), a script whose tools
// wait for their receipts, then run on Anvil until it exits: the send and confirm spans of each transaction must
// arrive under the AI SDK's span of the tool that sent it.
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

it('gives each tool call a send and a confirm span when the agent script exits', async () => {
  const entry = applySkill({
    fixture: fileURLToPath(new URL('./skill-fixture/', import.meta.url)),
    entry: 'agent.ts',
    serviceName: 'treasury-agent',
    kind: 'script',
  });
  try {
    const { code, stderr } = await outcome(runProject(entry, receiver.endpoint, anvil.rpcUrl));
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  } finally {
    rmSync(dirname(entry), { recursive: true, force: true });
  }

  const { spans } = receiver;
  expect(new Set(spans.map((span) => span.service))).toEqual(new Set(['treasury-agent']));
  const tools = spans.filter((span) => span.name.startsWith('execute_tool '));
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    'execute_tool pay_vendor',
    'execute_tool withdraw_from_vault',
  ]);
  for (const tool of tools) {
    const children = spans.filter((span) => span.parentSpanId === tool.spanId);
    expect(children.map((span) => span.name).sort()).toEqual(['confirm 31337', 'send 31337']);
    // The withdrawal's confirm span ends after its revert reason is replayed: only flush() waits for it.
    const confirm = children.find((span) => span.name === 'confirm 31337');
    expect(confirm?.status?.code ?? 0).toBe(
      tool.name === 'execute_tool withdraw_from_vault' ? 2 : 0,
    );
  }
}, 90_000);
