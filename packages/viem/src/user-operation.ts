// User operations of smart accounts: `sendUserOperation` and `waitForUserOperationReceipt` of a bundler client.
import type { TxTracker, UserOperationConfirmHandle, UserOperationInput } from '@hashspan/core';
import { context, diag, type TimeInput } from '@opentelemetry/api';
import { addressOf, own } from './arguments.js';
import type { Pending } from './confirm/pending.js';
import {
  isReadable,
  isUserOperationTimeout,
  toUserOperationReceiptLike,
  unreadable,
  type ViemUserOperationReceipt,
} from './confirm/receipt.js';
import { recordLate } from './confirm/timing.js';
import { errorName } from './safe-tracker.js';
import type { SendTracing } from './send.js';
import type { AnyAction, BaseActions, TracedAction, ViemClientLike } from './types.js';

/** What the user operation actions need from the `withHashspan()` call and the extended client. */
export interface UserOperationDependencies {
  tracker: TxTracker;
  track(work: Promise<void>): void;
  settleOnce: Pending['settleOnce'];
  sending: SendTracing;
}

/** Adds the traced user operation actions of `client` to `actions`; `base` holds the client's own. */
export function addUserOperationActions(
  client: ViemClientLike,
  base: BaseActions<'sendUserOperation' | 'waitForUserOperationReceipt'>,
  actions: Partial<Record<TracedAction, AnyAction>>,
  {
    tracker,
    track,
    settleOnce,
    sending: { queryChainId, traceSend, untraced },
  }: UserOperationDependencies,
): void {
  const { sendUserOperation, waitForUserOperationReceipt } = base;

  /**
   * The chain of a bundler client: its own, else that of the client it was created with (`createBundlerClient`'s
   * `client`). viem's user operation actions take no `chain` argument.
   */
  const userOperationChainId = (): number | undefined => {
    const id = client.chain?.id ?? (client as { client?: ViemClientLike }).client?.chain?.id;
    return typeof id === 'number' ? id : undefined;
  };

  // Of the bundler actions, only these two: viem calls the others from inside them (prepareUserOperation,
  // getUserOperationReceipt), but nothing calls these two, so no operation is traced twice (docs/adr/0021).
  if (typeof sendUserOperation === 'function') {
    actions.sendUserOperation = (args: unknown) =>
      traceSend(
        {
          chainId: userOperationChainId,
          start: (chainId, startTime) => {
            const handle = tracker.startUserOperationSend({
              ...userOperationInput(args, chainId),
              ...(startTime !== undefined ? { startTime } : {}),
            });
            return {
              context: handle.context,
              end: (userOpHash, endTime) =>
                handle.end({ userOpHash }, endTime !== undefined ? { endTime } : undefined),
              fail: (error, endTime) =>
                handle.fail(error, endTime !== undefined ? { endTime } : undefined),
            };
          },
          after: () => {},
        },
        () => sendUserOperation(args),
      );
  }

  /** What the send span of `sendUserOperation(args)` records, read from own data properties only. */
  const userOperationInput = (args: unknown, chainId: number): UserOperationInput => {
    const account = own(args, 'account') ?? client.account;
    const entryPoint = own(args, 'entryPointAddress') ?? own(own(account, 'entryPoint'), 'address');
    const calls = own(args, 'calls');
    const callCount = Array.isArray(calls) ? own(calls, 'length') : undefined;
    // Without an account, the arguments are a complete user operation with its `sender`.
    const sender = addressOf(account) ?? own(args, 'sender');
    return {
      chainId,
      sender: typeof sender === 'string' ? sender : undefined,
      entryPoint: typeof entryPoint === 'string' ? entryPoint : undefined,
      callCount: typeof callCount === 'number' ? callCount : undefined,
    };
  };

  if (typeof waitForUserOperationReceipt === 'function') {
    /**
     * Ends `waitingHandle` from the outcome of `wait`; never rejects. Resolves as soon as the handle has ended,
     * including when a flush that gave up ended it.
     */
    const recordUserOperationReceipt = (
      waitingHandle: UserOperationConfirmHandle,
      wait: Promise<ViemUserOperationReceipt>,
      endTimeOf: () => TimeInput | undefined = () => undefined,
    ): Promise<void> => {
      const confirmation = settleOnce(waitingHandle);
      const { handle } = confirmation;
      const options = () => {
        const endTime = endTimeOf();
        return endTime !== undefined ? { endTime } : undefined;
      };
      const record = async (): Promise<void> => {
        let receipt: ViemUserOperationReceipt;
        try {
          receipt = await wait;
        } catch (error) {
          if (!isReadable(error)) handle.fail(undefined, unreadable(options()?.endTime));
          else if (isUserOperationTimeout(error)) handle.timeout(options());
          else handle.fail(error, options());
          return;
        }
        try {
          handle.end(toUserOperationReceiptLike(receipt), options());
        } catch (error) {
          diag.error(`hashspan: failed to record user operation receipt (${errorName(error)})`);
          handle.fail(error, options());
        }
      };
      return Promise.race([record(), confirmation.ended]);
    };

    actions.waitForUserOperationReceipt = (args: unknown) => {
      let userOpHash: unknown;
      let chainId: number | undefined;
      try {
        userOpHash = own(args, 'hash');
        chainId = userOperationChainId();
      } catch (error) {
        untraced(error);
        return waitForUserOperationReceipt(args);
      }
      if (typeof userOpHash !== 'string') return waitForUserOperationReceipt(args);
      let handle: UserOperationConfirmHandle | undefined;
      if (chainId !== undefined) {
        try {
          handle = tracker.startUserOperationConfirm({ chainId, userOpHash });
        } catch (error) {
          diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
        }
      }
      const late =
        chainId === undefined
          ? { ctx: context.active(), startTime: new Date(), chainId: queryChainId() }
          : undefined;
      // Called synchronously, as without hashspan; a synchronous throw becomes a rejection the handle records.
      const wait = (async () =>
        waitForUserOperationReceipt(args))() as Promise<ViemUserOperationReceipt>;
      if (handle) {
        track(recordUserOperationReceipt(handle, wait));
      } else if (late) {
        track(
          recordLate(
            late.ctx,
            wait,
            () => late.chainId,
            (id) =>
              tracker.startUserOperationConfirm({
                chainId: id,
                userOpHash,
                startTime: late.startTime,
              }),
            (lateHandle, _id, endTimeOf) => recordUserOperationReceipt(lateHandle, wait, endTimeOf),
          ),
        );
      }
      return wait;
    };
  }
}
