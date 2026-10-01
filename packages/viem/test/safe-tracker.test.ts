import { createTxTracker, type TxTracker } from '@hashspan/core';
import { diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardTracker } from '../src/safe-tracker.js';
import { setupTracing, type TestTracing } from './tracing.js';

const HASH = `0x${'ab'.repeat(32)}`;
const payment = { chainId: 8453, protocol: 'x402' };

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.teardown();
});

describe('guardTracker().startPayment', () => {
  it('passes payments through to the tracker', () => {
    guardTracker(createTxTracker()).startPayment(payment).end({ status: 'settled', hash: HASH });
    expect(tracing.spans().map((s) => s.name)).toEqual(['payment 8453']);
  });

  it('records nothing for a tracker written for an older core, without startPayment', () => {
    const { startSend, startConfirm } = createTxTracker();
    const older = { startSend, startConfirm } as unknown as TxTracker;
    const handle = guardTracker(older).startPayment(payment);
    expect(() => handle.end({ status: 'settled' })).not.toThrow();
    expect(tracing.spans()).toEqual([]);
  });

  it('never throws when the tracker or its payment handle throws', () => {
    vi.spyOn(diag, 'error').mockImplementation(() => {});
    const boom = () => {
      throw new Error('tracker bug');
    };
    const throwing = { ...createTxTracker(), startPayment: boom } as unknown as TxTracker;
    const failingHandle = {
      ...createTxTracker(),
      startPayment: () => ({ end: boom, fail: boom }),
    } as unknown as TxTracker;
    const notAHandle = { ...createTxTracker(), startPayment: () => null } as unknown as TxTracker;
    for (const tracker of [throwing, failingHandle, notAHandle]) {
      const handle = guardTracker(tracker).startPayment(payment);
      expect(() => handle.end({ status: 'settled' })).not.toThrow();
      expect(() => handle.fail(new Error('x'))).not.toThrow();
    }
  });
});

describe('guardTracker() handles', () => {
  it('pass every argument form on unchanged', () => {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        void calls.push([name, ...args]);
    const handle = { end: record('end'), fail: record('fail'), timeout: record('timeout') };
    const tracker = {
      startSend: () => handle,
      startConfirm: () => handle,
      startPayment: () => handle,
    } as unknown as TxTracker;
    const guarded = guardTracker(tracker);
    const options = { endTime: new Date(0), errorType: 'rejected' };
    guarded.startSend({ chainId: 1 }).end({ hash: HASH }, options);
    guarded.startSend({ chainId: 1 }).fail('boom', undefined, options);
    guarded.startConfirm({ chainId: 1, hash: HASH }).timeout(5);
    guarded.startPayment(payment).fail('boom', options);
    guarded.startPayment(payment).timeout(options);
    expect(calls).toEqual([
      ['end', { hash: HASH }, options],
      ['fail', 'boom', undefined, options],
      ['timeout', 5],
      ['fail', 'boom', options],
      ['timeout', options],
    ]);
  });
});
