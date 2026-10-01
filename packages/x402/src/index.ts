import {
  createTxTracker,
  type PaymentHandle,
  type PaymentSettlement,
  type TxTracker,
} from '@hashspan/core';
import {
  type FlushOptions,
  type ViemClientLike,
  type WithHashspanOptions as ViemOptions,
  withHashspan as withViemHashspan,
} from '@hashspan/viem';
import { type Context, context, diag } from '@opentelemetry/api';

export interface WithHashspanX402Options extends Omit<ViemOptions, 'confirm'> {
  /**
   * viem public client(s) to confirm settlements with: one client, used for every chain it is on, or a function
   * returning the client for a chain id. Without a reader, only payment spans are recorded; the adapter never
   * chooses an RPC endpoint itself.
   */
  reader?: ViemClientLike | ((chainId: number) => ViemClientLike | undefined) | undefined;
  /** How long to poll for the receipt of a settlement before the confirm span ends as `timeout`. Default: 120 000 ms. */
  confirmTimeoutMs?: number | undefined;
}

/** Returned by {@link withHashspan}; the x402 client itself gets hooks, nothing is replaced. */
export interface HashspanX402 {
  /**
   * Waits for tracing work still running after paid calls returned (payments without a response yet, then
   * confirmations through the reader), so their spans are ended before the OpenTelemetry SDK shuts down. Resolves
   * true when all of it finished, false on timeout (default 10 000 ms), ending payment spans still open as `timeout`;
   * never rejects. See
   * https://github.com/selimaytac/hashspan/blob/main/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
}

const WRAPPED = Symbol.for('hashspan.x402.wrapped');
const HOOKS = [
  'onBeforePaymentCreation',
  'onAfterPaymentCreation',
  'onPaymentCreationFailure',
  'onPaymentResponse',
] as const;
// The same default as @hashspan/viem's flush().
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
/** How long a payment may wait for its response: its authorization's validity, plus a grace period, bounded. */
const DEFAULT_VALIDITY_S = 300;
const GRACE_MS = 30_000;
const MIN_DEADLINE_MS = 30_000;
const MAX_DEADLINE_MS = 60 * 60 * 1000;
/** Payments waiting for a response; when more are open, the oldest ends as `timeout`. */
const MAX_OPEN_PAYMENTS = 1000;
const MAX_WARNINGS = 32;
const EIP155 = /^eip155:([1-9][0-9]{0,15})$/;
// Unknown networks are named in warnings only when they look like a CAIP-2 identifier.
const NETWORK_NAME = /^[a-z0-9-]{1,32}:[a-zA-Z0-9-]{1,64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SETTLEMENT_PENDING = 'settlement_pending';
const NO_SETTLEMENT = 'no_settlement';
// Timers without Node.js or DOM types, which src/ is type-checked without.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'unknown error';
}

/**
 * The value of `target`'s own data property `key`, or undefined for an accessor, an inherited or a missing property,
 * so that no getter runs. A Proxy's `getOwnPropertyDescriptor` trap still runs.
 */
function own(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The EIP-155 chain id of a CAIP-2 network such as `eip155:8453`. */
function chainIdOf(network: unknown): number | undefined {
  const match = typeof network === 'string' ? EIP155.exec(network) : null;
  const chainId = match ? Number(match[1]) : undefined;
  return chainId !== undefined && Number.isSafeInteger(chainId) ? chainId : undefined;
}

/** How long to wait for the response of a payment whose requirements allow `maxTimeoutSeconds`. */
function deadlineMs(maxTimeoutSeconds: unknown): number {
  const seconds =
    typeof maxTimeoutSeconds === 'number' &&
    Number.isFinite(maxTimeoutSeconds) &&
    maxTimeoutSeconds > 0
      ? maxTimeoutSeconds
      : DEFAULT_VALIDITY_S;
  return Math.min(Math.max(seconds * 1000 + GRACE_MS, MIN_DEADLINE_MS), MAX_DEADLINE_MS);
}

/** The settlement fields the payment span records, from a decoded `PAYMENT-RESPONSE`. */
function settlementOf(response: object): PaymentSettlement {
  const errorReason = stringOrUndefined(own(response, 'errorReason'));
  const status =
    own(response, 'success') === true
      ? 'settled'
      : errorReason === SETTLEMENT_PENDING
        ? 'pending'
        : 'failed';
  const amount = own(response, 'amount');
  return {
    status,
    hash: stringOrUndefined(own(response, 'transaction')),
    payer: stringOrUndefined(own(response, 'payer')),
    amount: typeof amount === 'string' || typeof amount === 'bigint' ? amount : undefined,
    errorReason: status === 'failed' ? errorReason : undefined,
  };
}

/** A payment between `onBeforePaymentCreation` and `onAfterPaymentCreation`. */
interface Start {
  startTime: Date;
  parent: Context;
}

/** A payment span waiting for the response to its payment. */
interface OpenPayment {
  chainId: number;
  handle: PaymentHandle;
  payload: object;
  requirements: object;
  timer: unknown;
  ended: boolean;
  done: Promise<void>;
  resolve: () => void;
}

/**
 * Traces the payments an x402 client makes, as `payment` spans
 * (https://github.com/selimaytac/hashspan/blob/main/docs/adr/0013-x402-payments.md). It registers hooks on the
 * `x402Client` (from `@x402/core/client`) that `@x402/fetch`, `@x402/axios` and `@x402/mcp` pay through, so pass
 * that client, not an `x402HTTPClient`. Call it once per client, right after creating it and before registering
 * hooks of your own, which could otherwise keep hashspan from seeing an outcome: a second call returns the first
 * handle, ignores its options and logs a `diag` warning. Its hooks never throw and never change a payment. x402 v2 payments on `eip155`
 * networks are traced; others are made untraced, with a warning.
 */
export function withHashspan(client: object, options: WithHashspanX402Options = {}): HashspanX402 {
  const { reader, confirmTimeoutMs, tracker: providedTracker, ...rest } = options;
  const tracker: TxTracker = providedTracker ?? createTxTracker(rest);
  // Confirmations reuse the viem adapter's receipt handling, on the same tracker.
  const viem = withViemHashspan({ ...rest, tracker });

  const starts = new WeakMap<object, Start>();
  // Insertion order is age, for MAX_OPEN_PAYMENTS.
  const open = new Map<object, OpenPayment>();
  // The open payment of a requirements object, for a creation failure reported after hashspan's after-hook ran.
  const byRequirements = new WeakMap<object, OpenPayment>();

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key) || warned.size >= MAX_WARNINGS) return;
    warned.add(key);
    diag.warn(message);
  };

  const readerFor = (chainId: number): ViemClientLike | undefined => {
    try {
      const found = typeof reader === 'function' ? reader(chainId) : reader;
      if (found && (found.chain?.id === undefined || found.chain.id === chainId)) return found;
      if (found) {
        diag.warn(
          `hashspan: the reader is on chain ${found.chain?.id}, not ${chainId}; not confirming the settlement`,
        );
      }
    } catch (error) {
      diag.error(`hashspan: the reader function failed (${errorName(error)})`);
    }
    return undefined;
  };

  /** Ends `payment` once with `record`; the payment is no longer open afterwards. */
  const finish = (
    payment: OpenPayment,
    what: string,
    record: (handle: PaymentHandle) => void,
  ): void => {
    if (payment.ended) return;
    payment.ended = true;
    timers.clearTimeout(payment.timer);
    open.delete(payment.payload);
    if (byRequirements.get(payment.requirements) === payment) {
      byRequirements.delete(payment.requirements);
    }
    payment.resolve();
    try {
      record(payment.handle);
    } catch (error) {
      diag.error(`hashspan: failed to record ${what} (${errorName(error)})`);
    }
  };
  const timeOut = (payment: OpenPayment): void =>
    finish(payment, 'payment timeout', (handle) => handle.timeout({ endTime: new Date() }));

  /** The chain id of the payment for `requirements`, or undefined when it is not traced. */
  const tracedChainId = (paymentRequired: unknown, requirements: unknown): number | undefined => {
    const version = own(paymentRequired, 'x402Version');
    if (version !== 2) {
      warnOnce(
        `version:${String(version)}`,
        `hashspan: not tracing x402 payments of version ${typeof version === 'number' ? version : 'unknown'}`,
      );
      return undefined;
    }
    const network = own(requirements, 'network');
    const chainId = chainIdOf(network);
    if (chainId === undefined) {
      const name = typeof network === 'string' && NETWORK_NAME.test(network) ? network : undefined;
      warnOnce(
        `network:${name ?? ''}`,
        `hashspan: not tracing x402 payments on ${name === undefined ? 'an unknown network' : `the network "${name}"`}`,
      );
    }
    return chainId;
  };

  const startPayment = (
    start: Start,
    chainId: number,
    paymentRequired: unknown,
    requirements: object,
    payload: unknown,
  ): PaymentHandle => {
    const signed = own(payload, 'payload');
    const payer =
      own(own(signed, 'authorization'), 'from') ?? own(own(signed, 'permit2Authorization'), 'from');
    const amount = own(requirements, 'amount');
    return tracker.startPayment(
      {
        chainId,
        protocol: 'x402',
        payer: stringOrUndefined(payer),
        recipient: stringOrUndefined(own(requirements, 'payTo')),
        asset: stringOrUndefined(own(requirements, 'asset')),
        amount: typeof amount === 'string' ? amount : undefined,
        x402: {
          scheme: stringOrUndefined(own(requirements, 'scheme')),
          resource: stringOrUndefined(own(own(paymentRequired, 'resource'), 'url')),
        },
        startTime: start.startTime,
      },
      start.parent,
    );
  };

  /** Runs a hook body; a hook returns nothing and never throws, so it cannot change or fail the payment. */
  const hook =
    (what: string, body: (ctx: unknown) => void) =>
    (ctx: unknown): undefined => {
      try {
        body(ctx);
      } catch (error) {
        diag.error(`hashspan: failed to ${what} (${errorName(error)})`);
      }
      return undefined;
    };

  const beforeCreation = hook('record the start of a payment', (ctx) => {
    const requirements = own(ctx, 'selectedRequirements');
    if (!isObject(requirements)) return;
    if (tracedChainId(own(ctx, 'paymentRequired'), requirements) === undefined) return;
    starts.set(requirements, { startTime: new Date(), parent: context.active() });
  });

  const afterCreation = hook('start a payment span', (ctx) => {
    const requirements = own(ctx, 'selectedRequirements');
    const payload = own(ctx, 'paymentPayload');
    if (!isObject(requirements) || !isObject(payload)) return;
    const start = starts.get(requirements);
    if (!start) return;
    starts.delete(requirements);
    const paymentRequired = own(ctx, 'paymentRequired');
    const chainId = chainIdOf(own(requirements, 'network'));
    if (chainId === undefined) return;
    if (open.size >= MAX_OPEN_PAYMENTS) {
      const oldest = open.values().next().value;
      if (oldest) timeOut(oldest);
    }
    const handle = startPayment(start, chainId, paymentRequired, requirements, payload);
    let resolve = (): void => {};
    const done = new Promise<void>((resolveDone) => {
      resolve = resolveDone;
    });
    const payment: OpenPayment = {
      chainId,
      handle,
      payload,
      requirements,
      timer: undefined,
      ended: false,
      done,
      resolve,
    };
    payment.timer = timers.setTimeout(
      () => timeOut(payment),
      deadlineMs(own(requirements, 'maxTimeoutSeconds')),
    );
    // The timer must not keep a process alive that is otherwise done.
    (payment.timer as { unref?: () => void } | undefined)?.unref?.();
    open.set(payload, payment);
    byRequirements.set(requirements, payment);
  });

  const creationFailure = hook('record a payment failure', (ctx) => {
    const requirements = own(ctx, 'selectedRequirements');
    if (!isObject(requirements)) return;
    const error = own(ctx, 'error');
    const start = starts.get(requirements);
    if (start) {
      starts.delete(requirements);
      const chainId = chainIdOf(own(requirements, 'network'));
      if (chainId === undefined) return;
      const handle = startPayment(
        start,
        chainId,
        own(ctx, 'paymentRequired'),
        requirements,
        undefined,
      );
      handle.fail(error, { endTime: new Date() });
      return;
    }
    // A hook that ran after hashspan's after-hook failed: the span was started, the payment was not made.
    const payment = byRequirements.get(requirements);
    if (payment) {
      finish(payment, 'payment failure', (handle) => handle.fail(error, { endTime: new Date() }));
    }
  });

  const paymentResponse = hook('record a payment settlement', (ctx) => {
    const payload = own(ctx, 'paymentPayload');
    const payment = isObject(payload) ? open.get(payload) : undefined;
    if (!payment) {
      diag.debug('hashspan: a payment response for no open payment span; not recording it');
      return;
    }
    const response = own(ctx, 'settleResponse');
    const endTime = new Date();
    if (!isObject(response)) {
      finish(payment, 'payment without a settlement', (handle) =>
        handle.fail(undefined, { errorType: NO_SETTLEMENT, endTime }),
      );
      return;
    }
    const settlement = settlementOf(response);
    finish(payment, 'payment settlement', (handle) => handle.end(settlement, { endTime }));
    const { hash } = settlement;
    if (settlement.status === 'failed' || hash === undefined || !TX_HASH.test(hash)) return;
    const network = own(response, 'network');
    if (network !== undefined && chainIdOf(network) !== payment.chainId) {
      diag.warn(
        'hashspan: the settlement is on another network than the payment; not confirming it',
      );
      return;
    }
    const confirmWith = readerFor(payment.chainId);
    if (confirmWith) {
      viem.watch(confirmWith, { hash, chainId: payment.chainId, timeoutMs: confirmTimeoutMs });
    }
  });

  /** Waits for every open payment to end; true if they did before `deadline`, else ends them as `timeout`. */
  const flushPayments = async (deadline: number): Promise<boolean> => {
    while (open.size > 0) {
      const remaining = deadline - Date.now();
      const settled =
        remaining > 0 &&
        (await new Promise<boolean>((resolve) => {
          const timer = timers.setTimeout(() => resolve(false), remaining);
          void Promise.all([...open.values()].map((payment) => payment.done)).then(() => {
            timers.clearTimeout(timer);
            resolve(true);
          });
        }));
      if (!settled) {
        for (const payment of [...open.values()]) timeOut(payment);
        return false;
      }
    }
    return true;
  };

  const handle: HashspanX402 = {
    flush: async (flushOptions) => {
      try {
        const deadline = Date.now() + (flushOptions?.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
        // In order: a response that arrives while payments are awaited can start a confirmation for viem to await.
        const paymentsDone = await flushPayments(deadline);
        const viemDone = await viem.flush({ timeoutMs: Math.max(0, deadline - Date.now()) });
        return paymentsDone && viemDone;
      } catch (error) {
        diag.error(`hashspan: flush failed (${errorName(error)})`);
        return false;
      }
    },
  };
  const noop: HashspanX402 = { flush: (flushOptions) => viem.flush(flushOptions) };

  const target = client as Record<PropertyKey, unknown>;
  const existing = own(target, WRAPPED as unknown as string) ?? target[WRAPPED];
  if (isObject(existing)) {
    diag.warn(
      'hashspan: this x402 client is already traced; ignoring the options of the second withHashspan()',
    );
    return existing as HashspanX402;
  }
  if (HOOKS.some((name) => typeof target[name] !== 'function')) {
    diag.warn(
      'hashspan: not tracing x402 payments: pass the x402Client (with onPaymentResponse, @x402/core 2.12 or later), not an x402HTTPClient',
    );
    return noop;
  }
  if (typeof tracker.startPayment !== 'function') {
    diag.warn(
      'hashspan: not tracing x402 payments: the tracker has no startPayment; use createTxTracker() from @hashspan/core 0.4 or later',
    );
    return noop;
  }
  try {
    Object.defineProperty(client, WRAPPED, { value: handle });
  } catch {
    diag.debug('hashspan: could not mark the x402 client as traced');
  }
  const register = (name: (typeof HOOKS)[number], body: (ctx: unknown) => undefined): void => {
    Reflect.apply(target[name] as (hook: unknown) => unknown, client, [body]);
  };
  try {
    register('onBeforePaymentCreation', beforeCreation);
    register('onAfterPaymentCreation', afterCreation);
    register('onPaymentCreationFailure', creationFailure);
    register('onPaymentResponse', paymentResponse);
  } catch (error) {
    diag.error(`hashspan: failed to register the x402 hooks (${errorName(error)})`);
  }
  return handle;
}
