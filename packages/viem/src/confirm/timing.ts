import { diag } from '@opentelemetry/api';
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
export async function chainIdOfClient(client: ViemClientLike): Promise<number> {
  const id = Number(await client.request({ method: 'eth_chainId' }));
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('invalid chain id');
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

/** Resolves after `ms`; its timer does not keep the process alive. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
