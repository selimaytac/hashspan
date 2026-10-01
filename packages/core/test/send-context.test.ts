import { context, diag, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTxTracker, type SendInput } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

const CHAIN_ID = 8453;
const HASH = `0x${'ab'.repeat(32)}`;
const RECEIPT = { status: 'success' as const, blockNumber: 1n, gasUsed: 21_000n };

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('the send context', () => {
  it('has the send span set, so the sending call nests under it', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool transfer');
    context.with(trace.setSpan(context.active(), tool), () => {
      const send = tracker.startSend({ chainId: CHAIN_ID });
      context.with(send.context, () =>
        trace.getTracer('test').startSpan('eth_sendRawTransaction').end(),
      );
      send.end({ hash: HASH });
    });
    tool.end();

    const sendSpan = tracing.spanNamed(`send ${CHAIN_ID}`);
    expect(trace.getSpan(context.active())).toBeUndefined();
    expect(tracing.spanNamed('eth_sendRawTransaction').parentSpanContext?.spanId).toBe(
      sendSpan.spanContext().spanId,
    );
    expect(sendSpan.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  });

  it('keeps the parent context, baggage included, and an explicit parent', () => {
    const tracker = createTxTracker();
    const parent = propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({ tenant: { value: 'acme' } }),
    );
    const send = tracker.startSend({ chainId: CHAIN_ID }, parent);
    expect(propagation.getBaggage(send.context)?.getEntry('tenant')?.value).toBe('acme');
    send.end({ hash: HASH });
    expect(trace.getSpan(send.context)?.spanContext().spanId).toBe(
      tracing.spanNamed(`send ${CHAIN_ID}`).spanContext().spanId,
    );
  });

  it('is the parent context when starting the send span failed', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool transfer');
    const parent = trace.setSpan(ROOT_CONTEXT, tool);
    expect(tracker.startSend(null as unknown as SendInput, parent).context).toBe(parent);
    context.with(parent, () => {
      expect(tracker.startSend(null as unknown as SendInput).context).toBe(context.active());
    });
    tool.end();
  });

  it('does not become the parent of a background confirmation', () => {
    const tracker = createTxTracker();
    const tool = trace.getTracer('test').startSpan('execute_tool transfer');
    context.with(trace.setSpan(context.active(), tool), () => {
      tracker.startSend({ chainId: CHAIN_ID }).end({ hash: HASH });
    });
    tool.end();
    // Outside any span, as a background watcher would be.
    tracker.startConfirm({ chainId: CHAIN_ID, hash: HASH }).end(RECEIPT);
    expect(tracing.spanNamed(`confirm ${CHAIN_ID}`).parentSpanContext?.spanId).toBe(
      tool.spanContext().spanId,
    );
  });
});
