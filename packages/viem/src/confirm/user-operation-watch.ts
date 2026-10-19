// `watchUserOperation()`: confirming a user operation sent outside the extended clients, from its hash through a
// bundler or from its bundle transaction's receipt (docs/adr/0031-watch-user-operation.md).
import type { TxTracker } from '@hashspan/core';
import { type Context, context, diag } from '@opentelemetry/api';
import { own } from '../arguments.js';
import { errorName } from '../safe-tracker.js';
import type { ViemClientLike, WatchUserOperationOptions } from '../types.js';
import { type Confirmation, DEFAULT_BACKGROUND_TIMEOUT_MS } from './confirmation.js';
import type { Pending } from './pending.js';
import {
  isHash,
  RECEIPT_LAG_RETRY_MS,
  sameHex,
  toUserOperationReceiptLike,
  unreadable,
  type ViemUserOperationReceipt,
} from './receipt.js';
import { chainIdOfClient, delay, durationOr, isChainId, within } from './timing.js';
import { findUserOperation } from './user-operation-event.js';

export interface UserOperationWatchDependencies {
  tracker: TxTracker;
  track(work: Promise<void>): void;
  settleOnce: Pending['settleOnce'];
  reserveBackground: Confirmation['reserveBackground'];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A nonce given as a string: decimal or `0x` hex, at most 78 digits, as many as a uint256 has in decimal. */
const NONCE_STRING = /^(?:0|[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** The nonce option as a bigint, or `null` when it is given but is not one. */
function nonceOf(value: unknown): bigint | undefined | null {
  if (value === undefined) return undefined;
  let nonce: bigint | undefined;
  if (typeof value === 'bigint') nonce = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) nonce = BigInt(value);
  else if (typeof value === 'string' && NONCE_STRING.test(value)) nonce = BigInt(value);
  return nonce !== undefined && nonce >= 0n && nonce <= MAX_UINT256 ? nonce : null;
}

/** What to watch, read from the options' own data properties and checked (ADR 0025 rules 2 and 3). */
type Target =
  | { kind: 'hash'; userOpHash: string }
  | {
      kind: 'bundle';
      bundleHash: string;
      sender: string;
      nonce: bigint | undefined;
      userOpHash: string | undefined;
    };

/** The target of `options`, or undefined when it names none or a value is not valid. */
function targetOf(options: unknown): Target | undefined {
  const bundleHash = own(options, 'bundleHash');
  const userOpHash = own(options, 'userOpHash');
  if (bundleHash === undefined) {
    return isHash(userOpHash) ? { kind: 'hash', userOpHash } : undefined;
  }
  const sender = own(options, 'sender');
  const nonce = nonceOf(own(options, 'nonce'));
  if (!isHash(bundleHash) || typeof sender !== 'string' || !ADDRESS.test(sender) || nonce === null)
    return undefined;
  if (userOpHash !== undefined && !isHash(userOpHash)) return undefined;
  return { kind: 'bundle', bundleHash, sender: sender.toLowerCase(), nonce, userOpHash };
}

/** The chain id of a client, else of the client a bundler client was created with (`createBundlerClient`'s `client`). */
function chainOfClient(client: ViemClientLike): unknown {
  return client.chain?.id ?? own(own(own(client, 'client'), 'chain'), 'id');
}

/** Whether `client` has viem's bundler actions, as a bundler client and a smart account SDK's client have. */
function isBundlerClient(client: ViemClientLike): boolean {
  return typeof own(client, 'getUserOperationReceipt') === 'function';
}

/** A plain copy of a bundler's raw user operation receipt, read from own data properties only. */
function copyUserOperationReceipt(
  raw: unknown,
): ViemUserOperationReceipt & { userOpHash: unknown } {
  const bundle = own(raw, 'receipt');
  return {
    userOpHash: own(raw, 'userOpHash'),
    success: own(raw, 'success'),
    actualGasCost: own(raw, 'actualGasCost'),
    actualGasUsed: own(raw, 'actualGasUsed'),
    sender: own(raw, 'sender'),
    nonce: own(raw, 'nonce'),
    paymaster: own(raw, 'paymaster'),
    entryPoint: own(raw, 'entryPoint'),
    reason: own(raw, 'reason'),
    receipt: {
      transactionHash: own(bundle, 'transactionHash'),
      blockNumber: own(bundle, 'blockNumber'),
    },
  };
}

const FAILED = Symbol('failed');

export function createUserOperationWatch({
  tracker,
  track,
  settleOnce,
  reserveBackground,
}: UserOperationWatchDependencies): (
  client: ViemClientLike,
  options: WatchUserOperationOptions,
) => void {
  /**
   * Polls `method` with `params` through the client's own `request` until it answers with an object, every
   * `retryMs`, until `deadline` or until `stopped()`; a failed request is polled again. Resolves with the answer, or
   * undefined. Never rejects.
   */
  const poll = async (
    client: ViemClientLike,
    method: string,
    params: unknown[],
    deadline: number,
    retryMs: number,
    stopped: () => boolean,
  ): Promise<unknown> => {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || stopped()) return undefined;
      const answer = await within(
        (async () => client.request({ method, params }))().catch((error: unknown) => {
          diag.debug(`hashspan: a ${method} request failed (${errorName(error)}); polling again`);
          return FAILED;
        }),
        remaining,
        `read ${method}`,
      );
      if (answer !== null && typeof answer === 'object') return answer;
      const left = deadline - Date.now();
      if (left <= 0 || stopped()) return undefined;
      await delay(Math.min(retryMs, left));
    }
  };

  /** Polls the bundler for the receipt of `userOpHash`, on a confirm span opened at the call. */
  const watchHash = (
    client: ViemClientLike,
    chainId: number,
    userOpHash: string,
    call: { ctx: Context; startTime: Date; deadline: number; retryMs: number },
    release: () => void,
  ): void => {
    const opened = context.with(call.ctx, () =>
      tracker.startUserOperationConfirm({ chainId, userOpHash, startTime: call.startTime }),
    );
    const confirmation = settleOnce(opened);
    const { handle } = confirmation;
    let ended = false;
    void confirmation.ended.then(() => {
      ended = true;
    });
    const record = async (): Promise<void> => {
      try {
        const raw = await poll(
          client,
          'eth_getUserOperationReceipt',
          [userOpHash],
          call.deadline,
          call.retryMs,
          () => ended,
        );
        if (raw === undefined) {
          handle.timeout();
          return;
        }
        const receipt = copyUserOperationReceipt(raw);
        // A receipt of another operation: none of its data is recorded.
        if (!sameHex(receipt.userOpHash, userOpHash)) {
          diag.debug(
            'hashspan: the bundler answered with the receipt of another user operation; not recording it',
          );
          handle.fail(undefined, unreadable(undefined));
          return;
        }
        handle.end(toUserOperationReceiptLike(receipt));
      } catch (error) {
        diag.error(`hashspan: failed to record user operation receipt (${errorName(error)})`);
        handle.fail(error);
      } finally {
        release();
      }
    };
    track(Promise.race([record(), confirmation.ended]));
  };

  /** Reads the bundle receipt and records the one operation of the target in it, if there is exactly one. */
  const watchBundle = (
    client: ViemClientLike,
    chainId: number,
    target: Extract<Target, { kind: 'bundle' }>,
    call: { ctx: Context; startTime: Date; deadline: number; retryMs: number },
    release: () => void,
  ): void => {
    const record = async (): Promise<void> => {
      try {
        const raw = await poll(
          client,
          'eth_getTransactionReceipt',
          [target.bundleHash],
          call.deadline,
          call.retryMs,
          () => false,
        );
        if (raw === undefined) {
          diag.debug(
            'hashspan: no receipt of the bundle transaction in time; not recording the user operation',
          );
          return;
        }
        const match = findUserOperation(raw, target);
        if (match.kind !== 'one') {
          const why = {
            none: 'no UserOperationEvent of the sender in the bundle',
            several: 'several UserOperationEvents of the sender in the bundle; give its nonce',
            'too many logs': 'the bundle receipt has more logs than are read',
            'other transaction': 'the receipt is of another transaction',
          }[match.kind];
          diag.warn(`hashspan: watchUserOperation() found ${why}; not recording it`);
          return;
        }
        const handle = context.with(call.ctx, () =>
          tracker.startUserOperationConfirm({
            chainId,
            userOpHash: match.userOpHash,
            startTime: call.startTime,
          }),
        );
        handle.end(match.receipt);
      } catch (error) {
        diag.error(`hashspan: failed to record a user operation (${errorName(error)})`);
      } finally {
        release();
      }
    };
    track(record());
  };

  return (client: ViemClientLike, options: WatchUserOperationOptions): void => {
    try {
      const target = targetOf(options);
      if (!target) {
        diag.debug(
          'hashspan: watchUserOperation() needs a valid userOpHash, or a valid bundleHash and sender; not recording it',
        );
        return;
      }
      if (target.kind === 'hash' && !isBundlerClient(client)) {
        diag.warn(
          'hashspan: watchUserOperation() with a userOpHash alone needs a bundler client; not recording it',
        );
        return;
      }
      const given: unknown = own(options, 'chainId');
      const clientChain = chainOfClient(client);
      const chainId: unknown = given ?? clientChain;
      if (chainId !== undefined && !isChainId(chainId)) {
        diag.debug('hashspan: watchUserOperation() got an invalid chain id; not recording it');
        return;
      }
      const timeoutMs = durationOr(own(options, 'timeoutMs'), DEFAULT_BACKGROUND_TIMEOUT_MS);
      const polling = own(client, 'pollingInterval');
      const call = {
        ctx: context.active(),
        startTime: new Date(),
        deadline: Date.now() + timeoutMs,
        retryMs: typeof polling === 'number' && polling > 0 ? polling : RECEIPT_LAG_RETRY_MS,
      };
      /** Polling another chain would only end in a timeout, or a receipt recorded for the wrong chain. */
      const watchOn = (clientChainId: number | undefined): void => {
        const id = chainId ?? clientChainId;
        if (clientChainId !== id || id === undefined) {
          if (clientChainId !== undefined) {
            diag.warn(
              `hashspan: watchUserOperation() got chain ${id} and a client on chain ${clientChainId}; not recording it`,
            );
          }
          return;
        }
        const reserved = reserveBackground();
        if (!reserved) return;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          reserved();
        };
        if (target.kind === 'hash') watchHash(client, id, target.userOpHash, call, release);
        else watchBundle(client, id, target, call, release);
      };
      if (clientChain !== undefined) {
        if (!isChainId(clientChain)) {
          diag.debug(
            'hashspan: watchUserOperation() got a client whose chain id is not one; not recording it',
          );
          return;
        }
        watchOn(clientChain);
        return;
      }
      // A client without a chain can be on any chain: ask it, within the watch's timeout.
      track(
        within(chainIdOfClient(client), timeoutMs, 'ask a client for its chain id').then(watchOn),
      );
    } catch (error) {
      diag.error(`hashspan: failed to watch a user operation (${errorName(error)})`);
    }
  };
}
