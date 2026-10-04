// Transactions: `sendTransaction`, `writeContract` and `waitForTransactionReceipt`.
import type { ConfirmHandle, SendInput, TxTracker } from '@hashspan/core';
import { context, diag } from '@opentelemetry/api';
import { type Abi, getAbiItem, toFunctionSelector } from 'viem';
import {
  abiForTelemetry,
  addressOf,
  authorizationsOf,
  dataOnly,
  descriptorOf,
  MAX_ARGUMENTS_COPY_DEPTH,
  MAX_ARGUMENTS_COPY_VALUES,
  own,
  selectorOf,
  shadowing,
} from './arguments.js';
import { type Confirmation, DEFAULT_BACKGROUND_TIMEOUT_MS } from './confirm/confirmation.js';
import {
  capturing,
  type ReplacementCapture,
  type ViemReceipt,
  type ViemReplacement,
} from './confirm/receipt.js';
import { confirmKey, type Recent } from './confirm/recent.js';
import { recordLate } from './confirm/timing.js';
import { errorName } from './safe-tracker.js';
import type { SendArgs, SendTrace, SendTracing } from './send.js';
import type {
  AnyAction,
  BackgroundConfirmOptions,
  BaseActions,
  TracedAction,
  ViemClientLike,
} from './types.js';

interface WriteContractArgs extends SendArgs {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[] | undefined;
}

interface WaitArgs {
  hash: string;
  chain?: { id: number } | null | undefined;
  onReplaced?: ((replacement: ViemReplacement) => void) | undefined;
}

/** What the transaction actions need from the `withHashspan()` call and the extended client. */
export interface TransactionDependencies {
  tracker: TxTracker;
  confirm: BackgroundConfirmOptions | undefined;
  abis: Recent<Abi>;
  track(work: Promise<void>): void;
  recordConfirmation: Confirmation['recordConfirmation'];
  confirmThrough: Confirmation['confirmThrough'];
  sending: SendTracing;
}

/** Adds the traced transaction actions of `client` to `actions`; `base` holds the client's own. */
export function addTransactionActions(
  client: ViemClientLike,
  base: BaseActions<'sendTransaction' | 'writeContract' | 'waitForTransactionReceipt'>,
  actions: Partial<Record<TracedAction, AnyAction>>,
  {
    tracker,
    confirm,
    abis,
    track,
    recordConfirmation,
    confirmThrough,
    sending: { knownChainId, queryChainId, traceSend, untraced },
  }: TransactionDependencies,
): void {
  const { sendTransaction, writeContract, waitForTransactionReceipt } = base;

  /** Work after a successful send: remember the ABI and start background confirmation. */
  const afterSend = (chainId: number, hash: string, abi: Abi | undefined): void => {
    try {
      if (abi) abis.set(confirmKey(chainId, hash), abi);
      if (confirm?.mode === 'background') {
        confirmThrough(client, chainId, hash, confirm.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS);
      }
    } catch (error) {
      diag.error(`hashspan: failed to start background confirmation (${errorName(error)})`);
    }
  };

  /** Records a transaction sent with `args`, described by `describe`; `abi` decodes its revert reason later. */
  const transactionSend = (
    args: SendArgs,
    describe: (chainId: number) => SendInput,
    abi?: Abi,
  ): SendTrace => ({
    chainId: () => knownChainId(args),
    start: (chainId, startTime) => {
      const handle = tracker.startSend(
        startTime === undefined ? describe(chainId) : { ...describe(chainId), startTime },
      );
      return {
        context: handle.context,
        end: (hash, endTime) => handle.end(hash, endTime),
        fail: (error, endTime) => handle.fail(error, endTime),
      };
    },
    after: (chainId, hash) => afterSend(chainId, hash, abi),
  });

  const sendInput = (
    args: SendArgs,
    to: string | null | undefined,
    chainId: number,
  ): SendInput => ({
    chainId,
    from: addressOf(own(args, 'account') ?? client.account),
    to: typeof to === 'string' ? to : undefined,
    value: own(args, 'value') as SendInput['value'],
    nonce: own(args, 'nonce') as SendInput['nonce'],
    authorizations: authorizationsOf(own(args, 'authorizationList')),
  });

  if (typeof sendTransaction === 'function') {
    actions.sendTransaction = (args: SendArgs) =>
      traceSend(
        transactionSend(args, (chainId) => ({
          ...sendInput(args, own(args, 'to') as string | undefined, chainId),
          functionSelector: selectorOf(own(args, 'data') as string | undefined),
        })),
        () => sendTransaction(args),
      );
  }

  if (typeof writeContract === 'function') {
    actions.writeContract = (args: WriteContractArgs) => {
      let functionName: string | undefined;
      let abi: Abi | undefined;
      let functionArguments: readonly unknown[] | undefined;
      try {
        functionName = own(args, 'functionName') as string | undefined;
        abi = abiForTelemetry(own(args, 'abi'), functionName);
        functionArguments = own(args, 'args') as readonly unknown[] | undefined;
      } catch (error) {
        untraced(error);
        return writeContract(args);
      }
      return traceSend(
        transactionSend(
          args,
          (chainId) => {
            let functionSelector: string | undefined;
            try {
              // `abi` holds only the functions named `functionName` (and the errors).
              const functions = abi?.filter((item) => item.type === 'function') ?? [];
              const item =
                functions.length > 1
                  ? getAbiItem({
                      abi,
                      name: functionName,
                      // Only overload matching reads the arguments, deeply: it gets a bounded copy without
                      // accessors.
                      args: dataOnly(functionArguments, MAX_ARGUMENTS_COPY_DEPTH, {
                        left: MAX_ARGUMENTS_COPY_VALUES,
                      }),
                    } as never)
                  : functions[0];
              functionSelector = item ? toFunctionSelector(item as never) : undefined;
            } catch {
              // Unknown or ambiguous ABI item, or arguments past the copy bound: record the function name only.
            }
            return {
              ...sendInput(args, own(args, 'address') as string | undefined, chainId),
              functionName,
              functionSelector,
              functionArguments,
            };
          },
          abi,
        ),
        () => writeContract(args),
      );
    };
  }

  if (typeof waitForTransactionReceipt === 'function') {
    /**
     * What tracing a wait needs, read without running a getter, or undefined when the wait is not traced: an
     * inherited hash, a hash or callback behind an accessor, a `chain` whose id is not a chain id, or arguments that
     * throw when read.
     */
    const prepareWait = (args: WaitArgs) => {
      try {
        const hash = own(args, 'hash');
        // viem reads the callback through the prototype chain as well.
        const onReplaced =
          args !== null && typeof args === 'object' ? descriptorOf(args, 'onReplaced') : undefined;
        if (typeof hash !== 'string' || (onReplaced !== undefined && !('value' in onReplaced))) {
          return undefined;
        }
        // Always wrapped, so that a replacement is attributed however the span is recorded (docs/adr/0008).
        const capture: ReplacementCapture = {};
        const chainId = knownChainId(args);
        if (chainId === null) return undefined;
        const waitArgs = shadowing(args, 'onReplaced', capturing(capture, onReplaced?.value));
        return { hash, chainId, capture, waitArgs };
      } catch (error) {
        untraced(error);
        return undefined;
      }
    };

    actions.waitForTransactionReceipt = async (args: WaitArgs) => {
      const prepared = prepareWait(args);
      if (!prepared) return waitForTransactionReceipt(args);
      const { hash, chainId, capture, waitArgs } = prepared;
      let handle: ConfirmHandle | undefined;
      if (chainId !== undefined) {
        try {
          handle = tracker.startConfirm({ chainId, hash });
        } catch (error) {
          diag.error(`hashspan: failed to start confirm span (${errorName(error)})`);
        }
      }
      const late =
        chainId === undefined
          ? { ctx: context.active(), startTime: new Date(), chainId: queryChainId() }
          : undefined;
      const wait = waitForTransactionReceipt(waitArgs) as Promise<ViemReceipt>;
      if (handle && chainId !== undefined) {
        track(recordConfirmation(chainId, hash, handle, wait, capture, client));
      } else if (late) {
        track(
          recordLate(
            late.ctx,
            wait,
            () => late.chainId,
            (id) => tracker.startConfirm({ chainId: id, hash, startTime: late.startTime }),
            (lateHandle, id, endTimeOf) =>
              recordConfirmation(id, hash, lateHandle, wait, capture, client, endTimeOf),
          ),
        );
      }
      return wait;
    };
  }
}
