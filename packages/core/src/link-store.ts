import type { Context, SpanContext } from '@opentelemetry/api';
import type { BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR } from './attributes.js';

export interface SentTransaction {
  /** Span context of the `send` span, used for the span link. */
  spanContext: SpanContext;
  /** Parent context of the `send` span, used when confirmation happens in the background. */
  parent: Context;
  /** Set when someone other than the sender pays the transaction's fee, such as a payment's facilitator. */
  feePayer?: typeof BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR;
}

interface Entry extends SentTransaction {
  expiresAt: number;
}

/** Bounded, TTL-evicted map from (chainId, tx hash) to the send span it came from. */
export class LinkStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs: number; maxEntries: number }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  set(chainId: number, hash: string, value: SentTransaction): void {
    const key = LinkStore.key(chainId, hash);
    this.entries.delete(key);
    this.entries.set(key, { ...value, expiresAt: Date.now() + this.ttlMs });
    // Map iteration order is insertion order, so the first keys are the oldest.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  get(chainId: number, hash: string): SentTransaction | undefined {
    const key = LinkStore.key(chainId, hash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private static key(chainId: number, hash: string): string {
    return `${chainId}:${hash.toLowerCase()}`;
  }
}
