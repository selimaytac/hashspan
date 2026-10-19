// The example run as a user runs it: `src/main.ts` with tsx in a process of its own, on a fresh Anvil, exporting over
// OTLP to a receiver in this file. The paid API, its facilitator and the token are all local: nothing leaves
// localhost. The assertions are the trace the README describes.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  outcome,
  type ReceivedSpan,
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

/** An attribute's value as OTLP/JSON carries it (an `intValue` is a string), or undefined. */
function attribute(span: ReceivedSpan, key: string): string | boolean | undefined {
  const value = span.attributes?.find((a) => a.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.boolValue;
}

it('traces the tip and the paid report under their tool calls, in one agent trace', async () => {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const child = spawn(
    process.execPath,
    [tsx, '--tsconfig', 'test/tsconfig.run.json', 'src/main.ts'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        RPC_URL: anvil.rpcUrl,
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
        // JSON instead of the default protobuf, so that the receiver can read what arrives.
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const { code, stdout, stderr } = await outcome(child);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('hashspan: all spans ended');

  const { spans } = receiver;
  const named = (name: string) => spans.filter((span) => span.name === name);
  const one = (name: string) => {
    const matching = named(name);
    expect(matching, `one span named "${name}"`).toHaveLength(1);
    return matching[0] as ReceivedSpan;
  };
  const childrenOf = (parent: ReceivedSpan) =>
    spans.filter((span) => span.parentSpanId === parent.spanId);

  expect(new Set(spans.map((span) => span.service))).toEqual(new Set(['research-agent']));
  // One trace, rooted in the AI SDK's agent span.
  const roots = spans.filter((span) => !span.parentSpanId);
  expect(roots.map((span) => span.name)).toEqual([expect.stringMatching(/^invoke_agent /)]);
  expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([roots[0]?.traceId]));

  // The tip: a send and a confirm span under the tool call, the confirm linked to the send.
  const tip = one('execute_tool tip_author');
  const send = one('send 31337');
  const confirms = named('confirm 31337');
  expect(confirms).toHaveLength(2);
  expect(
    childrenOf(tip)
      .map((span) => span.name)
      .sort(),
  ).toEqual(['confirm 31337', 'send 31337']);
  const tipConfirm = childrenOf(tip).find((span) => span.name === 'confirm 31337') as ReceivedSpan;
  expect(tipConfirm.links?.map((link) => link.spanId)).toEqual([send.spanId]);
  expect(attribute(send, 'gen_ai.agent.name')).toBe('research-agent');
  expect(attribute(send, 'blockchain.tx.value')).toBe(String(10n ** 16n));
  expect(attribute(tipConfirm, 'blockchain.tx.status')).toBe('success');
  expect(attribute(tipConfirm, 'blockchain.tx.hash')).toBe(attribute(send, 'blockchain.tx.hash'));

  // The report: a payment span under the tool call, settled and verified, and a confirm span for the facilitator's
  // settling transaction, linked to the payment. The agent sent nothing, so there is no second send span.
  const buy = one('execute_tool buy_report');
  const payment = one('payment 31337');
  expect(
    childrenOf(buy)
      .map((span) => span.name)
      .sort(),
  ).toEqual(['confirm 31337', 'payment 31337']);
  expect(attribute(payment, 'gen_ai.agent.name')).toBe('research-agent');
  expect(attribute(payment, 'blockchain.payment.status')).toBe('settled');
  expect(attribute(payment, 'blockchain.payment.verified')).toBe(true);
  expect(attribute(payment, 'blockchain.payment.amount')).toBe('10000');
  expect(attribute(payment, 'blockchain.payment.recipient')).toBe(
    '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  );
  expect(attribute(payment, 'x402.scheme')).toBe('exact');
  const settlement = childrenOf(buy).find((span) => span.name === 'confirm 31337') as ReceivedSpan;
  expect(settlement.links?.map((link) => link.spanId)).toEqual([payment.spanId]);
  expect(attribute(settlement, 'blockchain.tx.hash')).toBe(
    attribute(payment, 'blockchain.tx.hash'),
  );
  expect(attribute(settlement, 'blockchain.tx.status')).toBe('success');
}, 90_000);
