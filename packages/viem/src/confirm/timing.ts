import { type Context, context, diag } from '@opentelemetry/api';
import { errorName } from '../safe-tracker.js';
import type { ViemClientLike } from '../types.js';

/** How long after a call settled its telemetry still waits for the client's chain id before it is dropped. */
const CHAIN_ID_GRACE_MS = 30_000;

/** Timers of the JavaScript runtime; `src/` is type-checked without runtime-specific types. */
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/**
 * Resolves true once all of `work` has settled, or false after `ms`. Unlike the other internal timers, this one is
 * referenced: `flush()` is awaited before shutting down, so the process must stay alive until it resolves.
 */
export function settledWithin(work: Promise<unknown>[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve(false), ms);
    void Promise.all(work).then(() => {
      timers.clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The chain id a client's node reports, from `eth_chainId`; rejects for an answer that is not one. */
/** Whether `id` is a chain id: a positive safe integer (ADR 0025). */
export function isChainId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

export async function chainIdOfClient(client: ViemClientLike): Promise<number> {
  const id = Number(await client.request({ method: 'eth_chainId' }));
  if (!isChainId(id)) throw new TypeError('invalid chain id');
  return id;
}

/** Resolves with `value`, or with undefined after `ms`. Never rejects; its timer does not keep the process alive. */
export function within<T>(value: Promise<T>, ms: number, what: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => {
      diag.debug(`hashspan: gave up waiting to ${what} after ${ms} ms`);
      resolve(undefined);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const done = (result: T | undefined): void => {
      timers.clearTimeout(timer);
      resolve(result);
    };
    value.then(done, () => done(undefined));
  });
}

/**
 * Resolves with the chain id, or with undefined if the request fails or is still pending `CHAIN_ID_GRACE_MS` after
 * `settled`. Never rejects, and its timer does not keep the process alive.
 */
export function chainIdOrGiveUp(
  chainId: Promise<number>,
  settled: Promise<unknown>,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let timer: unknown;
    let finished = false;
    const done = (id: number | undefined): void => {
      finished = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      resolve(id);
    };
    chainId.then(done, (error: unknown) => {
      diag.debug(`hashspan: could not resolve the chain id (${errorName(error)})`);
      done(undefined);
    });
    const startGrace = (): void => {
      // The chain id may have arrived before the call settled: then there is nothing to wait for.
      if (finished) return;
      timer = timers.setTimeout(() => {
        diag.debug('hashspan: chain id still unknown after the call settled; not recording it');
        done(undefined);
      }, CHAIN_ID_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    settled.then(startGrace, startGrace);
  });
}

/**
 * Records a wait whose chain id was unknown when it started, once it is known: `start` opens its confirm span in the
 * caller's context `ctx`, and `record` records the wait with the time it settled. `chainId` is called after the wait
 * is watched for that time. Never rejects.
 */
export async function recordLate<H>(
  ctx: Context,
  wait: Promise<unknown>,
  chainId: () => Promise<number>,
  start: (chainId: number) => H,
  record: (handle: H, chainId: number, endTimeOf: () => Date) => Promise<void>,
): Promise<void> {
  let endTime: Date | undefined;
  const settled = wait.then(
    () => {
      endTime = new Date();
    },
    () => {
      endTime = new Date();
    },
  );
  const id = await chainIdOrGiveUp(chainId(), settled);
  if (id === undefined) return;
  try {
    const handle = context.with(ctx, () => start(id));
    await record(handle, id, () => endTime ?? new Date());
  } catch (error) {
    diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
  }
}

/** The longest delay a JavaScript timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `value` if it is a duration in milliseconds, a finite non-negative number, else `fallback`: a timeout comes from the
 * caller's options, which may hold any value (ADR 0025). A duration longer than a timer can wait is cut to that.
 */
export function durationOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_TIMER_MS)
    : fallback;
}

/** Resolves after `ms`; its timer does not keep the process alive. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
