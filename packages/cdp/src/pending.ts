// Tracing work this adapter runs itself, and the part of `flush()` that waits for it.
import { timers } from './helpers.js';

/** The pending work of one `withHashspan()` call. */
export interface Pending {
  /** Registers work that outlives the traced call, for `flush()` to await. */
  track(work: Promise<void>): void;
  /** Ends a tracked confirm span that is still open as `timeout`, for `flush()` to call when it gives up. */
  waiting: Set<() => void>;
  /** Waits for the tracked work; when `timeoutMs` passes first, ends what is still waiting and resolves false. */
  flushOwn(timeoutMs: number): Promise<boolean>;
}

export function createPending(): Pending {
  // Work this adapter runs itself, outside @hashspan/viem: confirm spans of network-scoped waits without a reader.
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  /** Ends a tracked confirm span that is still open as `timeout`, for `flush()` to call when it gives up. */
  const waiting = new Set<() => void>();

  const flushOwn = async (timeoutMs: number): Promise<boolean> => {
    const settled = await new Promise<boolean>((resolve) => {
      const timer = timers.setTimeout(() => resolve(false), timeoutMs);
      void Promise.all([...pending]).then(() => {
        timers.clearTimeout(timer);
        resolve(true);
      });
    });
    if (!settled) for (const abandon of [...waiting]) abandon();
    return settled;
  };
  return { track, waiting, flushOwn };
}
