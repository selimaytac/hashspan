import type { Context, SpanContext } from '@opentelemetry/api';

export interface SentTransaction {
  /** Span context of the `send` span, used for the span link. */
  spanContext: SpanContext;
  /** Parent context of the `send` span, used when confirmation happens in the background. */
  parent: Context;
}

interface Entry extends SentTransaction {
  expiresAt: number;
}

/** Bounded, TTL-evicted map from (chainId, tx hash) to the send span it came from. */
export class LinkStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly caseSensitive: boolean;

  /** Keys are hex hashes compared case-insensitively, unless `caseSensitive` (for opaque ids such as call batch ids). */
  constructor(options: { ttlMs: number; maxEntries: number; caseSensitive?: boolean }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.caseSensitive = options.caseSensitive ?? false;
  }

  get size(): number {
    return this.entries.size;
  }

  set(chainId: number, hash: string, value: SentTransaction): void {
    const key = this.key(chainId, hash);
    this.entries.delete(key);
    this.entries.set(key, { ...value, expiresAt: Date.now() + this.ttlMs });
    // Map iteration order is insertion order, so the first keys are the oldest.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  get(chainId: number, hash: string): SentTransaction | undefined {
    const key = this.key(chainId, hash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private key(chainId: number, hash: string): string {
    return `${chainId}:${this.caseSensitive ? hash : hash.toLowerCase()}`;
  }
}
