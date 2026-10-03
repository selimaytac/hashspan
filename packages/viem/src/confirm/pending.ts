// Tracing work that outlives a traced call, and `flush()`, which waits for it or ends what is left.
import type {
  CallBatchConfirmHandle,
  ConfirmHandle,
  UserOperationConfirmHandle,
} from '@hashspan/core';
import { diag } from '@opentelemetry/api';
import { errorName } from '../safe-tracker.js';
import type { FlushOptions } from '../types.js';
import { settledWithin } from './timing.js';

const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/** A confirm handle of a transaction or of a user operation. */
export type AnyConfirmHandle = ConfirmHandle | UserOperationConfirmHandle | CallBatchConfirmHandle;

export interface PendingConfirmation<H extends AnyConfirmHandle = ConfirmHandle> {
  /** Ends the wrapped handle at most once; later calls are ignored. */
  handle: H;
  /** Resolves once the handle has ended, by any path. */
  ended: Promise<void>;
  /** How `flush()` ends the underlying handle if it cannot wait any longer; `timeout` until replaced. */
  onAbandon(abandon: (handle: H) => void): void;
}

/** The pending work of one `withHashspan()` call, shared by every client extended with it. */
export interface Pending {
  /** Registers work that outlives the traced call, for `flush()` to await. */
  track(work: Promise<void>): void;
  flush(options?: FlushOptions): Promise<boolean>;
  /** Wraps `handle` so it ends at most once, and registers it with `flush()` until it has ended. */
  settleOnce<H extends AnyConfirmHandle>(handle: H): PendingConfirmation<H>;
}

export function createPending(): Pending {
  /** Tracing work that outlives the traced call, awaited by `flush()`. */
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    const settled = work.catch(() => {});
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  };
  /** Ends a confirm handle that is still waiting as `timeout`, for `flush()` to call when it cannot wait longer. */
  const waiting = new Set<() => void>();
  const flush = async ({
    timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  }: FlushOptions = {}): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    // Loop, because finishing work can start more (e.g. a late send starting a background confirmation).
    while (pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await settledWithin([...pending], remaining))) {
        // End what is left, so its spans are exported with the rest (docs/adr/0010).
        for (const abandon of [...waiting]) {
          try {
            abandon();
          } catch (error) {
            diag.error(`hashspan: failed to end a pending confirm span (${errorName(error)})`);
          }
        }
        diag.debug(`hashspan: flush gave up after ${timeoutMs} ms`);
        return false;
      }
    }
    return true;
  };

  /** Wraps `handle` so it ends at most once, and registers it with `flush()` until it has ended. */
  const settleOnce = <H extends AnyConfirmHandle>(handle: H): PendingConfirmation<H> => {
    let settled = false;
    let resolveEnded: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const settle = (end: () => void): void => {
      if (settled) return;
      settled = true;
      waiting.delete(abandon);
      try {
        end();
      } finally {
        resolveEnded();
      }
    };
    let onAbandon = (underlying: H): void => underlying.timeout();
    const abandon = (): void => settle(() => onAbandon(handle));
    waiting.add(abandon);
    return {
      handle: {
        end: (...args: unknown[]) => settle(() => Reflect.apply(handle.end, handle, args)),
        timeout: (...args: unknown[]) => settle(() => Reflect.apply(handle.timeout, handle, args)),
        fail: (...args: unknown[]) => settle(() => Reflect.apply(handle.fail, handle, args)),
      } as H,
      ended,
      onAbandon: (abandonWith) => {
        onAbandon = abandonWith;
      },
    };
  };

  return { track, flush, settleOnce };
}
