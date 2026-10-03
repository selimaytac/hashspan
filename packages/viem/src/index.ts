import {
  type CallBatchConfirmHandle,
  type CallBatchInput,
  type CallBatchStatusLike,
  type ConfirmHandle,
  createTxTracker,
  type SendInput,
  type TxTracker,
  type TxTrackerOptions,
  type UserOperationConfirmHandle,
  type UserOperationInput,
} from '@hashspan/core';
import { type Context, context, diag, type TimeInput } from '@opentelemetry/api';
import { type Abi, getAbiItem, toFunctionSelector } from 'viem';
// A namespace import: `sendCallsSync` is missing from older viem releases in the peer range, and a named import of it
// would fail to load there.
import * as viemActions from 'viem/actions';
import {
  abiForTelemetry,
  addressOf,
  authorizationsOf,
  dataOnly,
  descriptorOf,
  MAX_ARGUMENTS_COPY_DEPTH,
  own,
  selectorOf,
  shadowing,
} from './arguments.js';
import { createConfirmation, DEFAULT_BACKGROUND_TIMEOUT_MS } from './confirm/confirmation.js';
import { createPending } from './confirm/pending.js';
import {
  capturing,
  isCallsTimeout,
  isReadable,
  isUserOperationTimeout,
  nameOf,
  type ReplacementCapture,
  toUserOperationReceiptLike,
  unreadable,
  type ViemReceipt,
  type ViemReplacement,
  type ViemUserOperationReceipt,
} from './confirm/receipt.js';
import { confirmKey, Recent } from './confirm/recent.js';
import { chainIdOrGiveUp } from './confirm/timing.js';
import { createWatch } from './confirm/watch.js';
import { errorName, guardTracker } from './safe-tracker.js';
import type {
  AnyAction,
  BackgroundConfirmOptions,
  FlushOptions,
  TracedAction,
  ViemClientLike,
  WatchOptions,
} from './types.js';

export { type TraceTransportOptions, traceTransport } from './transport.js';
export type {
  BackgroundConfirmOptions,
  FlushOptions,
  TracedAction,
  ViemClientLike,
  WatchOptions,
} from './types.js';

export interface WithHashspanOptions extends TxTrackerOptions {
  /**
   * Tracker from `createTxTracker()` to report to, to share one between adapters. Defaults to one tracker per
   * `withHashspan()` call, so reuse the same `withHashspan()` result for a wallet client and a public client to link
   * sends to confirmations.
   */
  tracker?: TxTracker | undefined;
  /**
   * `{ mode: 'background' }` confirms every sent transaction without waiting for the caller to do so, by polling
   * for its receipt through the sending client. Off by default.
   */
  confirm?: BackgroundConfirmOptions | undefined;
  /**
   * Replay reverted transactions to record their revert reason (two extra RPC requests per reverted transaction, three
   * when the first replay does not revert).
   * `{ timeoutMs }` bounds the replay; if the provider has not answered by then, the receipt is recorded without a
   * reason. Default: true, with a 10 000 ms bound. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0005-revert-reason-replay.md.
   */
  decodeRevertReason?: boolean | { timeoutMs?: number | undefined } | undefined;
  /**
   * Most background confirmations (`confirm: { mode: 'background' }` and `watch()`) polling at once. A transaction
   * sent while that many are polling gets no background confirm span, and a `diag` warning is logged; waits of the
   * caller are not counted and always traced. Default: 256. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0018-background-confirmation-limit.md.
   */
  maxBackgroundConfirmations?: number | undefined;
}

const DEFAULT_MAX_BACKGROUND_CONFIRMATIONS = 256;
const DEFAULT_REVERT_REASON_TIMEOUT_MS = 10_000;

/** Client extension returned by {@link withHashspan}: the traced actions present on the client. */
export interface HashspanExtension {
  <TClient extends ViemClientLike>(
    client: TClient,
  ): Pick<TClient, Extract<keyof TClient, TracedAction>>;
  /**
   * Waits for tracing work still running after traced calls returned (background confirmations, revert reason
   * replays, calls recorded once their chain id is known), so their spans are ended before the OpenTelemetry SDK
   * shuts down. Resolves true when all of it finished, false on timeout; never rejects. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
  /**
   * Confirms a transaction sent outside the extended clients (for example by a wallet API) through `client`, in the
   * background: a confirm span with the receipt, revert reason and fees, linked to the send span when the same
   * tracker recorded one. Never throws and never waits; `flush()` awaits it. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0012-cdp-adapter.md.
   */
  watch(client: ViemClientLike, options: WatchOptions): void;
}

interface SendArgs {
  account?: string | { address: string } | null | undefined;
  chain?: { id: number } | null | undefined;
  to?: string | null | undefined;
  value?: bigint | undefined;
  nonce?: number | undefined;
  data?: string | undefined;
}

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

/**
 * A started send span, of a transaction, a user operation or a call batch, as `traceSend` ends it; `R` is what the
 * call returned: a hash, or a call batch's result.
 */
interface StartedSend<R = string> {
  context: Context;
  end(result: R, endTime?: Date): void;
  fail(error: unknown, endTime?: Date): void;
}

/**
 * viem client extension that traces transactions with `@hashspan/core`:
 * `client.extend(withHashspan())`. Apply it after other extensions such as `publicActions`,
 * which would otherwise replace the traced actions.
 */
export function withHashspan(options: WithHashspanOptions = {}): HashspanExtension {
  const {
    tracker: providedTracker,
    confirm,
    decodeRevertReason: decodeRevertReasonOption = true,
    maxBackgroundConfirmations: maxBackgroundOption,
    ...trackerOptions
  } = options;
  const maxBackgroundConfirmations =
    typeof maxBackgroundOption === 'number' && maxBackgroundOption >= 0
      ? maxBackgroundOption
      : DEFAULT_MAX_BACKGROUND_CONFIRMATIONS;
  // Guarded so that no tracker, including a user-provided one, can throw into the instrumented call.
  const decodeRevertReason = decodeRevertReasonOption !== false;
  const revertReasonTimeoutMs =
    (typeof decodeRevertReasonOption === 'object'
      ? decodeRevertReasonOption.timeoutMs
      : undefined) ?? DEFAULT_REVERT_REASON_TIMEOUT_MS;
  const tracker = guardTracker(providedTracker ?? createTxTracker(trackerOptions));
  /** ABIs of recent `writeContract` calls, to decode custom errors. */
  const abis = new Recent<Abi>();
  /** Revert reasons being or already fetched, so concurrent waits for one transaction fetch it once. */
  const revertReasons = new Recent<Promise<string | undefined>>();
  const { track, flush, settleOnce } = createPending();
  const { recordConfirmation, confirmThrough } = createConfirmation({
    tracker,
    decodeRevertReason,
    revertReasonTimeoutMs,
    maxBackgroundConfirmations,
    abis,
    revertReasons,
    track,
    settleOnce,
  });
  const watch = createWatch({ abis, confirmThrough, track });

  const extension = (client: ViemClientLike & Partial<Record<TracedAction, AnyAction>>) => {
    const knownChainId = (args: {
      chain?: { id: number } | null | undefined;
    }): number | undefined => {
      const id = own(own(args, 'chain'), 'id');
      return typeof id === 'number' ? id : client.chain?.id;
    };

    /**
     * Asks a client without a chain for its chain id. Concurrent calls share one request; the answer is not cached,
     * since a wallet can switch networks. Callers never await it before the call they trace
     * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0009-telemetry-off-the-call-path.md).
     */
    let pendingChainId: Promise<number> | undefined;
    const queryChainId = (): Promise<number> => {
      if (!pendingChainId) {
        const query = Promise.resolve()
          .then(() => client.request({ method: 'eth_chainId' }))
          .then((hex: string) => {
            const id = Number(hex);
            if (!Number.isSafeInteger(id)) throw new TypeError('invalid chain id');
            return id;
          });
        pendingChainId = query;
        const clear = (): void => {
          if (pendingChainId === query) pendingChainId = undefined;
        };
        query.then(clear, clear);
      }
      return pendingChainId;
    };

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

    /** How `traceSend` records one kind of send: a transaction, a user operation or a call batch. */
    interface SendTrace<R = string> {
      /** The chain id when it is known before the call. Reads the call's arguments, so it may throw. */
      chainId(): number | undefined;
      /** Starts the send span, in the active context. */
      start(chainId: number, startTime?: Date): StartedSend<R>;
      /** Work after a successful send. */
      after(chainId: number, result: R): void;
    }

    /**
     * Records a send whose chain id was unknown when it started, once the chain id is known: same parent context,
     * start and end time as the call. Never rejects.
     */
    const recordLateSend = async <R>(
      ctx: Context,
      startTime: Date,
      chainId: Promise<number>,
      result: Promise<R>,
      sendTrace: SendTrace<R>,
    ): Promise<void> => {
      let sent: { value: R } | undefined;
      let error: unknown;
      try {
        sent = { value: await result };
      } catch (thrown) {
        error = thrown;
      }
      const endTime = new Date();
      const id = await chainIdOrGiveUp(chainId, Promise.resolve());
      if (id === undefined) return;
      try {
        const handle = context.with(ctx, () => sendTrace.start(id, startTime));
        if (sent === undefined) {
          handle.fail(error, endTime);
          return;
        }
        handle.end(sent.value, endTime);
        sendTrace.after(id, sent.value);
      } catch (thrown) {
        diag.error(`hashspan: failed to record send span (${errorName(thrown)})`);
      }
    };

    const traceSend = async <R>(sendTrace: SendTrace<R>, send: () => Promise<R>): Promise<R> => {
      let chainId: number | undefined;
      try {
        chainId = sendTrace.chainId();
      } catch (error) {
        untraced(error);
        return send();
      }
      if (chainId === undefined) {
        // Telemetry must not delay the call: record it once the chain id is known (docs/adr/0009).
        const ctx = context.active();
        const startTime = new Date();
        const chainIdQuery = queryChainId();
        const result = send();
        track(recordLateSend(ctx, startTime, chainIdQuery, result, sendTrace));
        return result;
      }
      let handle: StartedSend<R> = { context: context.active(), end: () => {}, fail: () => {} };
      try {
        handle = sendTrace.start(chainId);
      } catch (error) {
        diag.error(`hashspan: failed to start send span (${errorName(error)})`);
      }
      let result: R;
      try {
        // Only the call runs in the send span's context, so the spans it creates nest under the send span; what
        // follows runs in the caller's (ADR 0015). The guarded tracker always provides a context.
        result = await context.with(handle.context, send);
      } catch (error) {
        handle.fail(error);
        throw error;
      }
      handle.end(result);
      sendTrace.after(chainId, result);
      return result;
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

    /**
     * Logs that reading the call's arguments for telemetry threw, for example on a Proxy whose traps throw; the caller
     * then makes the call untraced, so the read never affects it.
     */
    const untraced = (error: unknown): void => {
      diag.error(
        `hashspan: failed to read the call arguments; call not traced (${errorName(error)})`,
      );
    };

    const actions: Partial<Record<TracedAction, AnyAction>> = {};
    const {
      sendTransaction,
      writeContract,
      waitForTransactionReceipt,
      sendUserOperation,
      waitForUserOperationReceipt,
      sendCalls,
      sendCallsSync,
      waitForCallsStatus,
    } = client;

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
                const item = getAbiItem({
                  abi,
                  name: functionName,
                  // Overload matching reads the arguments deeply: it gets a copy without accessors.
                  args: dataOnly(functionArguments, MAX_ARGUMENTS_COPY_DEPTH),
                } as never);
                functionSelector = item ? toFunctionSelector(item as never) : undefined;
              } catch {
                // Unknown or ambiguous ABI item: record the function name only.
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
      /** Records a wait whose chain id was unknown when it started, once it is known. Never rejects. */
      const recordLateConfirmation = async (
        ctx: Context,
        startTime: Date,
        chainId: Promise<number>,
        hash: string,
        wait: Promise<ViemReceipt>,
        capture: ReplacementCapture,
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
        const id = await chainIdOrGiveUp(chainId, settled);
        if (id === undefined) return;
        try {
          const handle = context.with(ctx, () =>
            tracker.startConfirm({ chainId: id, hash, startTime }),
          );
          await recordConfirmation(
            id,
            hash,
            handle,
            wait,
            capture,
            client,
            () => endTime ?? new Date(),
          );
        } catch (error) {
          diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
        }
      };

      /**
       * What tracing a wait needs, read without running a getter, or undefined when the wait is not traced: an
       * inherited hash, a hash or callback behind an accessor, or arguments that throw when read.
       */
      const prepareWait = (args: WaitArgs) => {
        try {
          const hash = own(args, 'hash');
          // viem reads the callback through the prototype chain as well.
          const onReplaced =
            args !== null && typeof args === 'object'
              ? descriptorOf(args, 'onReplaced')
              : undefined;
          if (typeof hash !== 'string' || (onReplaced !== undefined && !('value' in onReplaced))) {
            return undefined;
          }
          // Always wrapped, so that a replacement is attributed however the span is recorded (docs/adr/0008).
          const capture: ReplacementCapture = {};
          const waitArgs = shadowing(args, 'onReplaced', capturing(capture, onReplaced?.value));
          return { hash, chainId: knownChainId(args), capture, waitArgs };
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
            recordLateConfirmation(late.ctx, late.startTime, late.chainId, hash, wait, capture),
          );
        }
        return wait;
      };
    }

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
      const entryPoint =
        own(args, 'entryPointAddress') ?? own(own(account, 'entryPoint'), 'address');
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

      /** Records a wait whose chain id was unknown when it started, once it is known. Never rejects. */
      const recordLateUserOperationReceipt = async (
        ctx: Context,
        startTime: Date,
        chainId: Promise<number>,
        userOpHash: string,
        wait: Promise<ViemUserOperationReceipt>,
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
        const id = await chainIdOrGiveUp(chainId, settled);
        if (id === undefined) return;
        try {
          const handle = context.with(ctx, () =>
            tracker.startUserOperationConfirm({ chainId: id, userOpHash, startTime }),
          );
          await recordUserOperationReceipt(handle, wait, () => endTime ?? new Date());
        } catch (error) {
          diag.error(`hashspan: failed to record confirm span (${errorName(error)})`);
        }
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
            recordLateUserOperationReceipt(
              late.ctx,
              late.startTime,
              late.chainId,
              userOpHash,
              wait,
            ),
          );
        }
        return wait;
      };
    }

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
        let chainId: number | undefined;
        try {
          id = own(args, 'id');
          // sendCallsSync passes its `chain` on to the wait, as a caller may.
          chainId = knownChainId(args as SendArgs);
        } catch (error) {
          untraced(error);
          return waitForCallsStatus(args);
        }
        if (typeof id !== 'string') return waitForCallsStatus(args);
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

    return actions;
  };

  return Object.assign(extension, { flush, watch }) as HashspanExtension;
}
