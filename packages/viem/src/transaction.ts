// Transactions: `sendTransaction`, `writeContract`, `sendRawTransaction`, their sync forms, and
// `waitForTransactionReceipt`.
import type { ConfirmHandle, SendInput, TxTracker } from '@hashspan/core';
import { type Context, context, diag } from '@opentelemetry/api';
import { type Abi, getAbiItem, parseTransaction, toFunctionSelector } from 'viem';
import {
  abiForTelemetry,
  addressOf,
  authorizationsOf,
  dataOnly,
  descriptorOf,
  isPlainObject,
  MAX_ARGUMENTS_COPY_DEPTH,
  MAX_ARGUMENTS_COPY_VALUES,
  own,
  selectorOf,
  shadowing,
} from './arguments.js';
import {
  type Confirmation,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  type RecheckOptions,
} from './confirm/confirmation.js';
import {
  capturing,
  type ReplacementCapture,
  type ViemReceipt,
  type ViemReplacement,
} from './confirm/receipt.js';
import { confirmKey, type Recent } from './confirm/recent.js';
import { durationOr, isChainId, recordLate } from './confirm/timing.js';
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

interface RawArgs {
  serializedTransaction: string;
}

/** Longest serialized transaction parsed for telemetry, as hex: nodes accept transactions up to 128 KiB. */
const MAX_RAW_TRANSACTION_LENGTH = 2 + 2 * 128 * 1024;

/**
 * The fields of the signed transaction a raw send broadcasts, read from own data properties only; undefined when it
 * is not one viem can parse, or is longer than {@link MAX_RAW_TRANSACTION_LENGTH}. Never throws.
 */
function parsedRaw(args: unknown): Record<string, unknown> | undefined {
  try {
    const raw = own(args, 'serializedTransaction');
    if (typeof raw !== 'string' || raw.length > MAX_RAW_TRANSACTION_LENGTH) return undefined;
    return parseTransaction(raw as `0x${string}`) as Record<string, unknown>;
  } catch {
    // Not a transaction viem can parse: the send span records the chain id only.
    return undefined;
  }
}

interface WaitArgs {
  hash: string;
  chain?: { id: number } | null | undefined;
  onReplaced?: ((replacement: ViemReplacement) => void) | undefined;
}

/** viem's default `timeout` of `waitForTransactionReceipt`. */
const VIEM_WAIT_TIMEOUT_MS = 180_000;

/**
 * For a wait with `confirmations` above 1, how its receipt is read again once it resolved (ADR 0026); undefined for any
 * other wait. Read from own data properties only.
 */
function recheckOf(args: unknown): RecheckOptions | undefined {
  const confirmations = own(args, 'confirmations');
  if (typeof confirmations !== 'number' || !(confirmations > 1)) return undefined;
  return { timeoutMs: durationOr(own(args, 'timeout'), VIEM_WAIT_TIMEOUT_MS) };
}

/** Most `cause` links followed to find the receipt in the rejection of a sync action. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The receipt in the rejection of a sync action called with `throwOnReceiptRevert`: viem throws its
 * `TransactionReceiptRevertedError`, wrapped in a transaction error (and a contract error), once the transaction
 * reverted. Read from own data properties only; undefined for any other rejection, also when reading it throws.
 */
function revertedReceiptOf(error: unknown): unknown {
  try {
    let current = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
      if (own(current, 'name') === 'TransactionReceiptRevertedError')
        return own(current, 'receipt');
      current = own(current, 'cause');
    }
  } catch {
    // A rejection that cannot be read is recorded as a failed send.
  }
  return undefined;
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
  base: BaseActions<
    | 'sendTransaction'
    | 'writeContract'
    | 'sendTransactionSync'
    | 'writeContractSync'
    | 'sendRawTransaction'
    | 'sendRawTransactionSync'
    | 'waitForTransactionReceipt'
  >,
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
  const {
    sendTransaction,
    writeContract,
    sendTransactionSync,
    writeContractSync,
    sendRawTransaction,
    sendRawTransactionSync,
    waitForTransactionReceipt,
  } = base;

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

  /**
   * What the send span of a contract write records, and the ABI that decodes its revert reason; read from own data
   * properties only. Throws when reading the arguments throws: the call is then made untraced.
   */
  const contractWrite = (
    args: WriteContractArgs,
  ): { abi: Abi | undefined; describe: (chainId: number) => SendInput } => {
    const functionName = own(args, 'functionName') as string | undefined;
    const abi = abiForTelemetry(own(args, 'abi'), functionName);
    const functionArguments = own(args, 'args') as readonly unknown[] | undefined;
    const describe = (chainId: number): SendInput => {
      let functionSelector: string | undefined;
      try {
        // `abi` holds only the functions named `functionName` (and the errors).
        const functions = abi?.filter((item) => item.type === 'function') ?? [];
        const item =
          functions.length > 1
            ? getAbiItem({
                abi,
                name: functionName,
                // Only overload matching reads the arguments, deeply: it gets a bounded copy without accessors.
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
    };
    return { abi, describe };
  };

  /** What the send span of `sendTransaction(args)` and `sendTransactionSync(args)` records. */
  const transactionInput = (args: SendArgs, chainId: number): SendInput => ({
    ...sendInput(args, own(args, 'to') as string | undefined, chainId),
    functionSelector: selectorOf(own(args, 'data') as string | undefined),
  });

  if (typeof sendTransaction === 'function') {
    actions.sendTransaction = (args: SendArgs) =>
      traceSend(
        transactionSend(args, (chainId) => transactionInput(args, chainId)),
        () => sendTransaction(args),
      );
  }

  if (typeof writeContract === 'function') {
    actions.writeContract = (args: WriteContractArgs) => {
      let write: ReturnType<typeof contractWrite>;
      try {
        write = contractWrite(args);
      } catch (error) {
        untraced(error);
        return writeContract(args);
      }
      return traceSend(transactionSend(args, write.describe, write.abi), () => writeContract(args));
    };
  }

  /**
   * Records the receipt a sync action returned, or threw with, on a confirm span from `startTime` to `endTime`: the
   * call's own, since viem sends and waits in it. Never awaited by the call, so the revert reason replay runs after it
   * returned (ADR 0009).
   */
  const confirmReceipt = (
    parent: Context,
    chainId: number,
    hash: string,
    receipt: unknown,
    abi: Abi | undefined,
    startTime: Date,
    endTime: Date,
  ): void => {
    try {
      if (abi) abis.set(confirmKey(chainId, hash), abi);
      const handle = context.with(parent, () => tracker.startConfirm({ chainId, hash, startTime }));
      track(
        recordConfirmation(
          chainId,
          hash,
          handle,
          Promise.resolve(receipt as ViemReceipt),
          {},
          client,
          () => endTime,
        ),
      );
    } catch (error) {
      diag.error(`hashspan: failed to record the receipt (${errorName(error)})`);
    }
  };

  /**
   * Records a sync action, which sends a transaction and waits for its receipt in one call (viem 2.38.0): the send
   * span covers the call and ends with the hash of the receipt, as viem returns the hash only with the receipt, and a
   * confirm span with the same start and end records the receipt. A rejection that carries the receipt of a reverted
   * transaction (`throwOnReceiptRevert`) is recorded as that receipt; nothing else of the call's result is read.
   */
  const syncSend = (
    args: SendArgs,
    describe: (chainId: number) => SendInput,
    abi?: Abi,
  ): SendTrace<unknown> => ({
    chainId: () => knownChainId(args),
    start: (chainId, startTime) => {
      const callStart = startTime ?? new Date();
      // The caller's context: the confirm span is started in it, as a wait the caller makes after a send would be.
      const parent = context.active();
      const handle = tracker.startSend({ ...describe(chainId), startTime: callStart });
      /** Ends the send span with the hash of `receipt` and records the receipt; false when it has no hash. */
      const received = (receipt: unknown, endTime: Date): boolean => {
        const hash = own(receipt, 'transactionHash');
        if (typeof hash !== 'string') return false;
        handle.end({ hash }, { endTime });
        confirmReceipt(parent, chainId, hash, receipt, abi, callStart, endTime);
        return true;
      };
      return {
        context: handle.context,
        end: (receipt, endTime) => {
          const at = endTime instanceof Date ? endTime : new Date();
          try {
            if (received(receipt, at)) return;
          } catch (error) {
            diag.error(`hashspan: failed to read the receipt (${errorName(error)})`);
          }
          // A receipt without a readable hash: the send succeeded, but nothing can be confirmed.
          handle.end({ hash: '' }, { endTime: at });
        },
        fail: (error, endTime) => {
          const at = endTime instanceof Date ? endTime : new Date();
          const receipt = revertedReceiptOf(error);
          try {
            if (receipt !== undefined && received(receipt, at)) return;
          } catch (thrown) {
            diag.error(`hashspan: failed to read the receipt (${errorName(thrown)})`);
          }
          handle.fail(error, { endTime: at });
        },
      };
    },
    // The receipt is recorded as the send span ends: nothing to confirm in the background.
    after: () => {},
  });

  if (typeof sendTransactionSync === 'function') {
    actions.sendTransactionSync = (args: SendArgs) =>
      traceSend(
        syncSend(args, (chainId) => transactionInput(args, chainId)),
        () => sendTransactionSync(args),
      );
  }

  if (typeof writeContractSync === 'function') {
    actions.writeContractSync = (args: WriteContractArgs) => {
      let write: ReturnType<typeof contractWrite>;
      try {
        write = contractWrite(args);
      } catch (error) {
        untraced(error);
        return writeContractSync(args);
      }
      return traceSend(syncSend(args, write.describe, write.abi), () => writeContractSync(args));
    };
  }

  /**
   * The chain id and what the send span of a raw send records, from the signed transaction: its own chain id, else
   * the client's; never its sender, which only its signature gives (#33). Parsed once, before the call.
   */
  const rawSend = (
    args: RawArgs,
  ): { chainId: () => number | undefined; describe: (chainId: number) => SendInput } => {
    const parsed = parsedRaw(args);
    const parsedChainId = parsed?.chainId;
    return {
      chainId: () => (isChainId(parsedChainId) ? parsedChainId : (knownChainId({}) ?? undefined)),
      describe: (chainId) => {
        const to = parsed?.to;
        const value = parsed?.value;
        const nonce = parsed?.nonce;
        return {
          chainId,
          to: typeof to === 'string' ? to : undefined,
          value: typeof value === 'bigint' ? value : undefined,
          nonce: typeof nonce === 'number' ? nonce : undefined,
          functionSelector: selectorOf(parsed?.data as string | undefined),
          authorizations: authorizationsOf(parsed?.authorizationList),
        };
      },
    };
  };

  if (typeof sendRawTransaction === 'function') {
    actions.sendRawTransaction = (args: RawArgs) => {
      const raw = rawSend(args);
      return traceSend(
        { ...transactionSend(args as SendArgs, raw.describe), chainId: raw.chainId },
        () => sendRawTransaction(args),
      );
    };
  }

  if (typeof sendRawTransactionSync === 'function') {
    actions.sendRawTransactionSync = (args: RawArgs) => {
      const raw = rawSend(args);
      return traceSend({ ...syncSend(args as SendArgs, raw.describe), chainId: raw.chainId }, () =>
        sendRawTransactionSync(args),
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
        // Arguments that are not a plain object, such as a class instance, are passed on as they are: the wait is
        // traced, but a replacement is not attributed.
        const waitArgs = isPlainObject(args)
          ? shadowing(args, 'onReplaced', capturing(capture, onReplaced?.value))
          : args;
        return { hash, chainId, capture, waitArgs, recheck: recheckOf(args) };
      } catch (error) {
        untraced(error);
        return undefined;
      }
    };

    actions.waitForTransactionReceipt = async (args: WaitArgs) => {
      const prepared = prepareWait(args);
      if (!prepared) return waitForTransactionReceipt(args);
      const { hash, chainId, capture, waitArgs, recheck } = prepared;
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
        track(
          recordConfirmation(
            chainId,
            hash,
            handle,
            wait,
            capture,
            client,
            undefined,
            undefined,
            recheck,
          ),
        );
      } else if (late) {
        track(
          recordLate(
            late.ctx,
            wait,
            () => late.chainId,
            (id) => tracker.startConfirm({ chainId: id, hash, startTime: late.startTime }),
            (lateHandle, id, endTimeOf) =>
              recordConfirmation(
                id,
                hash,
                lateHandle,
                wait,
                capture,
                client,
                endTimeOf,
                undefined,
                recheck,
              ),
          ),
        );
      }
      return wait;
    };
  }
}
