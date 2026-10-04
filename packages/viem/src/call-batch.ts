// EIP-5792 call batches: `sendCalls`, `waitForCallsStatus` and `sendCallsSync` of a wallet client.
import type {
  CallBatchConfirmHandle,
  CallBatchInput,
  CallBatchStatusLike,
  TxTracker,
} from '@hashspan/core';
import { type Context, context, diag, type TimeInput } from '@opentelemetry/api';
// A namespace import: `sendCallsSync` is missing from older viem releases in the peer range, and a named import of it
// would fail to load there.
import * as viemActions from 'viem/actions';
import { addressOf, own } from './arguments.js';
import { type Confirmation, DEFAULT_BACKGROUND_TIMEOUT_MS } from './confirm/confirmation.js';
import type { Pending } from './confirm/pending.js';
import { isCallsTimeout, isReadable, nameOf, unreadable } from './confirm/receipt.js';
import { chainIdOrGiveUp } from './confirm/timing.js';
import { errorName } from './safe-tracker.js';
import type { SendArgs, SendTracing } from './send.js';
import type {
  AnyAction,
  BackgroundConfirmOptions,
  BaseActions,
  TracedAction,
  ViemClientLike,
} from './types.js';

// The suffix of the id viem returns for a batch it sent as plain transactions (`experimental_fallback`): the
// transaction hashes (a zero hash for a call that failed to send), the chain id, then this. Copied from viem; the
// fallback tests in test/call-batch.test.ts and test/call-batch.int.test.ts run the installed viem's fallback.
const FALLBACK_ID_SUFFIX = '5792'.repeat(16);

/** The transactions of a fallback batch id, without failed calls; undefined for any other id. */
function fallbackTransactionHashes(id: string): string[] | undefined {
  if (!/^0x(?:[0-9a-fA-F]{64}){3,}$/.test(id) || !id.endsWith(FALLBACK_ID_SUFFIX)) return undefined;
  const words = id.slice(2, -128).match(/.{64}/g) ?? [];
  return words.filter((word) => !/^0+$/.test(word)).map((word) => `0x${word}`);
}

/** The id of a `sendCalls` result: an object with `id`, or a string from viem's earlier experimental action. */
function callBatchIdOf(result: unknown): string | undefined {
  const id = typeof result === 'string' ? result : own(result, 'id');
  return typeof id === 'string' ? id : undefined;
}

/** Normalises a viem call batch status; read from own data properties only. */
function toCallBatchStatusLike(status: unknown): CallBatchStatusLike {
  const statusCode = own(status, 'statusCode');
  const atomic = own(status, 'atomic');
  const receipts = own(status, 'receipts');
  const length = Array.isArray(receipts) ? own(receipts, 'length') : 0;
  return {
    statusCode: typeof statusCode === 'number' ? statusCode : undefined,
    atomic: typeof atomic === 'boolean' ? atomic : undefined,
    receipts: Array.from({ length: typeof length === 'number' ? length : 0 }, (_, i) => {
      const receipt = own(receipts, String(i));
      const transactionHash = own(receipt, 'transactionHash');
      const blockNumber = own(receipt, 'blockNumber');
      return {
        transactionHash: typeof transactionHash === 'string' ? transactionHash : undefined,
        blockNumber:
          typeof blockNumber === 'bigint' || typeof blockNumber === 'number'
            ? blockNumber
            : undefined,
      };
    }),
  };
}

/** What the call batch actions need from the `withHashspan()` call and the extended client. */
export interface CallBatchDependencies {
  tracker: TxTracker;
  confirm: BackgroundConfirmOptions | undefined;
  track(work: Promise<void>): void;
  settleOnce: Pending['settleOnce'];
  confirmThrough: Confirmation['confirmThrough'];
  sending: SendTracing;
}

/** Adds the traced call batch actions of `client` to `actions`; `base` holds the client's own. */
export function addCallBatchActions(
  client: ViemClientLike,
  base: BaseActions<'sendCalls' | 'sendCallsSync' | 'waitForCallsStatus'>,
  actions: Partial<Record<TracedAction, AnyAction>>,
  {
    tracker,
    confirm,
    track,
    settleOnce,
    confirmThrough,
    sending: { knownChainId, queryChainId, traceSend, untraced },
  }: CallBatchDependencies,
): void {
  const { sendCalls, sendCallsSync, waitForCallsStatus } = base;

  // EIP-5792 call batches (docs/adr/0022-call-batches.md). getCallsStatus is not wrapped: waitForCallsStatus polls it.
  if (typeof sendCalls === 'function') {
    actions.sendCalls = (args: unknown) =>
      traceSend<unknown>(
        {
          chainId: () => knownChainId(args as SendArgs),
          start: (chainId, startTime) => {
            const handle = tracker.startCallBatchSend({
              ...callBatchInput(args, chainId),
              ...(startTime !== undefined ? { startTime } : {}),
            });
            return {
              context: handle.context,
              end: (result, endTime) => {
                // The result comes from the wallet: reading it must never reject a call that succeeded.
                let id = '';
                try {
                  id = callBatchIdOf(result) ?? '';
                } catch (error) {
                  diag.error(`hashspan: failed to read the call batch id (${errorName(error)})`);
                }
                handle.end(
                  { id, transactionHashes: fallbackTransactionHashes(id) },
                  endTime !== undefined ? { endTime } : undefined,
                );
              },
              fail: (error, endTime) =>
                handle.fail(error, endTime !== undefined ? { endTime } : undefined),
            };
          },
          // The transactions of viem's fallback are the account's own: always confirmed as transactions, as
          // watch() does, so their fees are recorded with the sealed receipt (ADR 0022, ADR 0024).
          after: (chainId, result) => {
            let id: string | undefined;
            try {
              id = callBatchIdOf(result);
            } catch (error) {
              diag.error(`hashspan: failed to read the call batch id (${errorName(error)})`);
            }
            for (const hash of (id && fallbackTransactionHashes(id)) || []) {
              try {
                confirmThrough(
                  client,
                  chainId,
                  hash,
                  confirm?.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
                );
              } catch (error) {
                diag.error(
                  `hashspan: failed to confirm a fallback transaction (${errorName(error)})`,
                );
              }
            }
          },
        },
        () => sendCalls(args),
      );
  }

  /** What the send span of `sendCalls(args)` records, read from own data properties only. */
  const callBatchInput = (args: unknown, chainId: number): CallBatchInput => {
    const calls = own(args, 'calls');
    const callCount = Array.isArray(calls) ? own(calls, 'length') : undefined;
    return {
      chainId,
      sender: addressOf(own(args, 'account') ?? client.account),
      callCount: typeof callCount === 'number' ? callCount : undefined,
    };
  };

  if (typeof waitForCallsStatus === 'function') {
    /**
     * Ends `waitingHandle` from the outcome of `wait`; never rejects. Resolves as soon as the handle has ended,
     * including when a flush that gave up ended it.
     */
    const recordCallBatchStatus = (
      waitingHandle: CallBatchConfirmHandle,
      wait: Promise<unknown>,
      endTimeOf: () => TimeInput | undefined = () => undefined,
    ): Promise<void> => {
      const confirmation = settleOnce(waitingHandle);
      const { handle } = confirmation;
      const options = () => {
        const endTime = endTimeOf();
        return endTime !== undefined ? { endTime } : undefined;
      };
      const record = async (): Promise<void> => {
        let status: unknown;
        try {
          status = await wait;
        } catch (error) {
          // With throwOnFailure, a failed batch rejects with its status: recorded as that status.
          if (!isReadable(error)) {
            handle.fail(undefined, unreadable(options()?.endTime));
            return;
          }
          if (nameOf(error) === 'BundleFailedError') {
            try {
              status = own(error, 'result');
            } catch {
              handle.fail(error, options());
              return;
            }
          } else {
            if (isCallsTimeout(error)) handle.timeout(options());
            else handle.fail(error, options());
            return;
          }
        }
        try {
          handle.end(toCallBatchStatusLike(status), options());
        } catch (error) {
          diag.error(`hashspan: failed to record call batch status (${errorName(error)})`);
          handle.fail(error, options());
        }
      };
      return Promise.race([record(), confirmation.ended]);
    };

    /** Records a wait whose chain id was unknown when it started, once it is known. Never rejects. */
    const recordLateCallBatchStatus = async (
      ctx: Context,
      startTime: Date,
      id: string,
      wait: Promise<unknown>,
    ): Promise<void> => {
      let endTime: Date | undefined;
      const settled = wait.then(
        () => {
          endTime = new Date();
        },
        () => {
          endTime = new Date();
        },
      );
      // The status names its chain; without one, the client is asked once the wait has settled.
      const chainId = wait.then(
        (status) => {
          const reported = own(status, 'chainId');
          return typeof reported === 'number' ? reported : queryChainId();
        },
        () => queryChainId(),
      );
      const known = await chainIdOrGiveUp(chainId, settled);
      if (known === undefined) return;
      try {
        const handle = context.with(ctx, () =>
          tracker.startCallBatchConfirm({ chainId: known, id, startTime }),
        );
        await recordCallBatchStatus(handle, wait, () => endTime ?? new Date());
      } catch (error) {
        diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
      }
    };

    actions.waitForCallsStatus = (args: unknown) => {
      let id: unknown;
      let chainId: number | null | undefined;
      try {
        id = own(args, 'id');
        // sendCallsSync passes its `chain` on to the wait, as a caller may.
        chainId = knownChainId(args as SendArgs);
      } catch (error) {
        untraced(error);
        return waitForCallsStatus(args);
      }
      if (typeof id !== 'string' || chainId === null) return waitForCallsStatus(args);
      let handle: CallBatchConfirmHandle | undefined;
      if (chainId !== undefined) {
        try {
          handle = tracker.startCallBatchConfirm({ chainId, id });
        } catch (error) {
          diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
        }
      }
      const late =
        chainId === undefined ? { ctx: context.active(), startTime: new Date() } : undefined;
      // Called synchronously, as without hashspan; a synchronous throw becomes a rejection the handle records.
      const wait = (async () => waitForCallsStatus(args))() as Promise<unknown>;
      if (handle) track(recordCallBatchStatus(handle, wait));
      else if (late) track(recordLateCallBatchStatus(late.ctx, late.startTime, id, wait));
      return wait;
    };
  }

  // viem's sendCallsSync calls sendCalls and waitForCallsStatus of the client it gets, so it runs here with the
  // traced ones: one send span and one confirm span, with viem's own logic (docs/adr/0022-call-batches.md).
  const viemSendCallsSync: unknown = (viemActions as Record<string, unknown>).sendCallsSync;
  if (
    typeof sendCallsSync === 'function' &&
    typeof viemSendCallsSync === 'function' &&
    actions.sendCalls &&
    actions.waitForCallsStatus
  ) {
    const traced = {
      ...client,
      sendCalls: actions.sendCalls,
      waitForCallsStatus: actions.waitForCallsStatus,
    };
    actions.sendCallsSync = (args: unknown) =>
      (viemSendCallsSync as (client: unknown, args: unknown) => Promise<unknown>)(traced, args);
  }
}
