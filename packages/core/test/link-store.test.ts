import { ROOT_CONTEXT, type SpanContext, TraceFlags } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkStore } from '../src/link-store.js';

const spanContext = (spanId: string): SpanContext => ({
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId,
  traceFlags: TraceFlags.SAMPLED,
});

describe('LinkStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores entries per chain and case-insensitive hash', () => {
    const store = new LinkStore({ ttlMs: 1000, maxEntries: 10 });
    store.set(1, '0xABC', { spanContext: spanContext('00f067aa0ba902b7'), parent: ROOT_CONTEXT });
    expect(store.get(1, '0xabc')?.spanContext.spanId).toBe('00f067aa0ba902b7');
    expect(store.get(10, '0xabc')).toBeUndefined();
  });

  it('expires entries after the TTL', () => {
    const store = new LinkStore({ ttlMs: 1000, maxEntries: 10 });
    store.set(1, '0xabc', { spanContext: spanContext('00f067aa0ba902b7'), parent: ROOT_CONTEXT });
    vi.advanceTimersByTime(999);
    expect(store.get(1, '0xabc')).toBeDefined();
    vi.advanceTimersByTime(2);
    expect(store.get(1, '0xabc')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const store = new LinkStore({ ttlMs: 60_000, maxEntries: 2 });
    store.set(1, '0x1', { spanContext: spanContext('0000000000000001'), parent: ROOT_CONTEXT });
    store.set(1, '0x2', { spanContext: spanContext('0000000000000002'), parent: ROOT_CONTEXT });
    store.set(1, '0x3', { spanContext: spanContext('0000000000000003'), parent: ROOT_CONTEXT });
    expect(store.get(1, '0x1')).toBeUndefined();
    expect(store.get(1, '0x2')).toBeDefined();
    expect(store.get(1, '0x3')).toBeDefined();
    expect(store.size).toBe(2);
  });
});
