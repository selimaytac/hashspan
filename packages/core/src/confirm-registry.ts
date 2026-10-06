/**
 * A confirm span shared by every handle for one transaction. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@1.0.0/docs/adr/0007-confirmation-ownership.md.
 */
export interface SharedConfirm {
  /** Handles that have neither ended the span nor withdrawn. */
  active: number;
  /** Set once the span ended; later calls on any handle are ignored. */
  ended: boolean;
}

type Entry<T> = { confirm: T } | { settledUntil: number };

/**
 * Bounded registry from (chainId, tx hash) to its in-flight confirm span, or to "settled" for a while after a
 * receipt was recorded, so each transaction gets one confirm span per tracker.
 */
export class ConfirmRegistry<T extends SharedConfirm> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs: number; maxEntries: number }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  /** The in-flight confirm span, `'settled'` if the transaction recently got a receipt, else undefined. */
  get(chainId: number, hash: string): T | 'settled' | undefined {
    const key = ConfirmRegistry.key(chainId, hash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if ('confirm' in entry) return entry.confirm;
    if (entry.settledUntil > Date.now()) return 'settled';
    this.entries.delete(key);
    return undefined;
  }

  start(chainId: number, hash: string, confirm: T): void {
    this.put(ConfirmRegistry.key(chainId, hash), { confirm });
  }

  /** Marks `confirm` as settled, unless the registry has since moved on from it. */
  settle(chainId: number, hash: string, confirm: T): void {
    const key = ConfirmRegistry.key(chainId, hash);
    if (this.isCurrent(key, confirm)) this.put(key, { settledUntil: Date.now() + this.ttlMs });
  }

  /** Forgets `confirm` so that a retry starts a new span, unless the registry has since moved on from it. */
  release(chainId: number, hash: string, confirm: T): void {
    const key = ConfirmRegistry.key(chainId, hash);
    if (this.isCurrent(key, confirm)) this.entries.delete(key);
  }

  private isCurrent(key: string, confirm: T): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && 'confirm' in entry && entry.confirm === confirm;
  }

  private put(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Map iteration order is insertion order, so the first keys are the oldest.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  private static key(chainId: number, hash: string): string {
    return `${chainId}:${hash.toLowerCase()}`;
  }
}
