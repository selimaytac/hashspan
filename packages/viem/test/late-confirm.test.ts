import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordLate } from '../src/confirm/timing.js';
import { withHashspan } from '../src/index.js';
import { mockBundler, stubAccount, USER_OP_HASH } from './mock-bundler.js';
import { FROM, HASH, mockTransport } from './mock-transport.js';
import { setupTracing, type TestTracing } from './tracing.js';
import { viemHasAction } from './viem-version.js';

// A wait whose chain id is unknown when it starts is recorded once the id is known: under the span that was active
// when the wait started, and ending when the wait settled, for each kind of confirm span.

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

const toMs = (t: [number, number] | undefined) => (t ? t[0] * 1e3 + t[1] / 1e6 : Number.NaN);
const later = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** Runs `wait` under a tool span; returns the tool span and the time the wait settled. */
async function underTool(wait: () => Promise<unknown>) {
  const tool = trace.getTracer('test').startSpan('execute_tool pay');
  await context.with(trace.setSpan(context.active(), tool), wait);
  const settled = Date.now();
  tool.end();
  return { tool, settled };
}

function expectLateConfirm(name: string, toolId: string, settled: number) {
  const confirm = tracing.spanNamed(name);
  expect(confirm.parentSpanContext?.spanId).toBe(toolId);
  // The chain id arrives well after the wait settled: the span ends when the wait did, not at that moment.
  expect(toMs(confirm.endTime)).toBeLessThan(settled + 75);
}

describe('a wait on a client without a chain', () => {
  it('records the transaction confirm span under the caller, ending when the wait settled', async () => {
    const { transport } = mockTransport({ chainId: () => later(150, '0x2105') });
    const hashspan = withHashspan();
    const reader = createPublicClient({ transport, pollingInterval: 10 }).extend(hashspan);

    const { tool, settled } = await underTool(() =>
      reader.waitForTransactionReceipt({ hash: HASH }),
    );
    expect(await hashspan.flush()).toBe(true);

    expectLateConfirm('confirm 8453', tool.spanContext().spanId, settled);
  });

  it('records the user operation confirm span under the caller, ending when the wait settled', async () => {
    const bundler = mockBundler({ chainId: () => later(150, '0x14a34') });
    const account = await stubAccount(bundler.transport);
    const hashspan = withHashspan();
    const client = createBundlerClient({ account, transport: bundler.transport }).extend(hashspan);

    const { tool, settled } = await underTool(() =>
      client.waitForUserOperationReceipt({ hash: USER_OP_HASH }),
    );
    expect(await hashspan.flush()).toBe(true);

    expectLateConfirm('confirm 84532', tool.spanContext().spanId, settled);
  });

  it.skipIf(!viemHasAction('waitForCallsStatus'))(
    'records the call batch confirm span under the caller, ending when the wait settled',
    async () => {
      const { transport } = mockTransport({ chainId: () => later(150, '0x2105') });
      const hashspan = withHashspan();
      const wallet = createWalletClient({ account: FROM, transport, pollingInterval: 10 }).extend(
        hashspan,
      );

      const { tool, settled } = await underTool(() => wallet.waitForCallsStatus({ id: '0xb47c4' }));
      expect(await hashspan.flush()).toBe(true);

      expectLateConfirm('confirm 8453', tool.spanContext().spanId, settled);
    },
  );
});

describe('recordLate', () => {
  it('starts the confirm span in the context it is given, whatever context it runs in', async () => {
    const tool = trace.getTracer('test').startSpan('execute_tool pay');
    const ctx = trace.setSpan(ROOT_CONTEXT, tool);
    let active: unknown;
    await context.with(ROOT_CONTEXT, () =>
      recordLate(
        ctx,
        Promise.resolve(),
        () => Promise.resolve(8453),
        () => {
          active = trace.getActiveSpan();
        },
        async () => {},
      ),
    );
    tool.end();
    expect(active).toBe(tool);
  });
});
