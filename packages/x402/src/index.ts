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
import { decodeEventLog, decodeFunctionData, parseAbi } from 'viem';

/**
 * Options of {@link withHashspan}: those of `@hashspan/viem`'s `withHashspan()` except `confirm`, and the reader to
 * confirm settlements with.
 */
export interface WithHashspanX402Options extends Omit<ViemOptions, 'confirm'> {
  /**
   * viem public client(s) to confirm settlements with: one client, used for every chain it is on, or a function
   * returning the client for a chain id. Without a reader, only payment spans are recorded; the adapter never
   * chooses an RPC endpoint itself.
   */
  reader?: ViemClientLike | ((chainId: number) => ViemClientLike | undefined) | undefined;
  /** How long to poll for the receipt of a settlement before the confirm span ends as `timeout`. Default: 120 000 ms. */
  confirmTimeoutMs?: number | undefined;
  /**
   * Replay reverted settlements to record their revert reason, as in `@hashspan/viem`. Default: false: the server you
   * pay chooses the settling transaction, and with it the contract whose revert text would be recorded. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.10.0/docs/adr/0013-x402-payments.md.
   */
  decodeRevertReason?: ViemOptions['decodeRevertReason'];
}

/** Returned by {@link withHashspan}; the x402 client itself gets hooks, nothing is replaced. */
export interface HashspanX402 {
  /**
   * Waits for tracing work still running after paid calls returned (payments without a response yet, then
   * confirmations through the reader), so their spans are ended before the OpenTelemetry SDK shuts down. Resolves
   * true when all of it finished, false on timeout (default 10 000 ms), ending payment spans still open as `timeout`;
   * never rejects. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.10.0/docs/adr/0010-flush-before-shutdown.md.
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

/**
 * The `timeoutMs` of flush options, read as an own data property, as @hashspan/viem's flush() reads it: the default for
 * options without a usable one, or that cannot be read (such as a revoked Proxy), so `flush()` always resolves.
 */
function flushTimeoutOf(options: unknown): number {
  try {
    const value = own(options, 'timeoutMs');
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.min(value, 2 ** 31 - 1)
      : DEFAULT_FLUSH_TIMEOUT_MS;
  } catch {
    return DEFAULT_FLUSH_TIMEOUT_MS;
  }
}
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
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
/** The events an EIP-3009 settlement emits on the token; decoded with this ABI only, never a caller's. */
const EIP3009_EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
/** The events an x402 Permit2 proxy emits once it settled a payment; they carry no payment identifier. */
const PROXY_EVENTS = parseAbi(['event Settled()', 'event SettledWithPermit()']);
const TRANSFER_EVENT = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
// The settlement functions of the x402 Permit2 proxies; their Permit2 permit carries the payment's nonce.
const PERMIT2_STRUCTS = [
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'struct Permit2612 { uint256 value; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }',
] as const;
const EXACT_PROXY_FUNCTIONS = parseAbi([
  ...PERMIT2_STRUCTS,
  'struct Witness { address to; uint256 validAfter; }',
  'function settle(PermitTransferFrom permit, address owner, Witness witness, bytes signature)',
  'function settleWithPermit(Permit2612 permit2612, PermitTransferFrom permit, address owner, Witness witness, bytes signature)',
]);
const UPTO_PROXY_FUNCTIONS = parseAbi([
  ...PERMIT2_STRUCTS,
  'struct Witness { address to; address facilitator; uint256 validAfter; }',
  'function settle(PermitTransferFrom permit, uint256 amount, address owner, Witness witness, bytes signature)',
  'function settleWithPermit(Permit2612 permit2612, PermitTransferFrom permit, uint256 amount, address owner, Witness witness, bytes signature)',
]);
/** How long to wait for the settlement transaction of a Permit2 payment, to read its nonce. */
const TRANSACTION_TIMEOUT_MS = 10_000;
const SETTLEMENT_PENDING = 'settlement_pending';
const NO_SETTLEMENT = 'no_settlement';
// Timers without Node.js or DOM types, which src/ is type-checked without.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/** An error name `diag` messages include: short text, as a class name is. */
const ERROR_NAME = /^[A-Za-z0-9_.$-]{1,64}$/;

/** What `diag` logs for an error: its name, if it is short text. Never throws, also for a name that cannot be read. */
function errorName(error: unknown): string {
  try {
    const name: unknown = error instanceof Error ? error.name : undefined;
    // Text only: a symbol would throw where the name is put into a message.
    return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'unknown error';
  } catch {
    return 'unknown error';
  }
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

/**
 * A plain copy of the options object, with the own enumerable properties that can be read: an option whose read
 * throws gets its default, and anything but an object gives all defaults, with a `diag` warning (ADR 0025 rule 1).
 */
function optionsOf(given: unknown): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if ((typeof given !== 'object' && typeof given !== 'function') || given === null) {
    if (given !== undefined) diag.warn('hashspan: options must be an object; using defaults');
    return options;
  }
  let keys: string[];
  try {
    keys = Object.keys(given);
  } catch {
    diag.warn('hashspan: could not read the options; using defaults');
    return options;
  }
  for (const key of keys) {
    try {
      options[key] = (given as Record<string, unknown>)[key];
    } catch {
      diag.warn(`hashspan: could not read the ${key} option; using its default`);
    }
  }
  return options;
}

/** Whether `tracker` can record payments; a tracker that cannot be read cannot (ADR 0025 rule 1). */
function hasStartPayment(tracker: TxTracker): boolean {
  try {
    return typeof tracker.startPayment === 'function';
  } catch {
    diag.debug('hashspan: could not read the tracker');
    return false;
  }
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

/** What identifies an `exact` EIP-3009 payment in a receipt, all from the payer's own payload and requirements. */
interface Eip3009Check {
  method: 'eip3009';
  asset: string;
  payer: string;
  payTo: string;
  nonce: string;
  amount: bigint;
}

/** What identifies an `exact` Permit2 payment in a receipt, all from the payer's own payload and requirements. */
interface Permit2Check {
  method: 'permit2';
  asset: string;
  payer: string;
  payTo: string;
  /** The x402 proxy the payer authorized to transfer, which the settlement transaction calls. */
  proxy: string;
  /** The Permit2 nonce the payer signed, which the settlement transaction passes to the proxy. */
  nonce: bigint;
  amount: bigint;
}

/** What identifies an `upto` payment in a receipt: a Permit2 payment of at most `max`, sent by `facilitator`. */
interface UptoCheck {
  method: 'upto';
  asset: string;
  payer: string;
  payTo: string;
  proxy: string;
  nonce: bigint;
  facilitator: string;
  max: bigint;
}

type PaymentCheck = Eip3009Check | Permit2Check | UptoCheck;

/** `value` lower-cased when it is an address, else undefined. */
function addressOf(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

/** `value` as an amount when it is a decimal string, else undefined. */
function amountOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && AMOUNT.test(value) ? BigInt(value) : undefined;
}

const lower = (value: unknown): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

/**
 * The check of an `exact` payment authorized with EIP-3009 (`transferWithAuthorization`), or undefined for any
 * other scheme or authorization method
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.10.0/docs/adr/0017-x402-payment-verification.md).
 */
function eip3009CheckOf(requirements: object, payload: object): Eip3009Check | undefined {
  if (own(requirements, 'scheme') !== 'exact') return undefined;
  const authorization = own(own(payload, 'payload'), 'authorization');
  const values = {
    asset: own(requirements, 'asset'),
    payer: own(authorization, 'from'),
    payTo: own(requirements, 'payTo'),
    nonce: own(authorization, 'nonce'),
    amount: own(requirements, 'amount'),
  };
  const { asset, payer, payTo, nonce, amount } = values;
  if (typeof asset !== 'string' || !ADDRESS.test(asset)) return undefined;
  if (typeof payer !== 'string' || !ADDRESS.test(payer)) return undefined;
  if (typeof payTo !== 'string' || !ADDRESS.test(payTo)) return undefined;
  if (typeof nonce !== 'string' || !BYTES32.test(nonce)) return undefined;
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) return undefined;
  return {
    method: 'eip3009',
    asset: asset.toLowerCase(),
    payer: payer.toLowerCase(),
    payTo: payTo.toLowerCase(),
    nonce: nonce.toLowerCase(),
    amount: BigInt(amount),
  };
}

/**
 * The check of an `exact` or `upto` payment authorized with Permit2 (`permit2Authorization`), or undefined for any
 * other scheme or authorization method, or when the authorization does not match the requirements: another token,
 * recipient or amount, or for `upto` no facilitator
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.10.0/docs/adr/0017-x402-payment-verification.md).
 */
function permit2CheckOf(
  requirements: object,
  payload: object,
): Permit2Check | UptoCheck | undefined {
  const scheme = own(requirements, 'scheme');
  if (scheme !== 'exact' && scheme !== 'upto') return undefined;
  const authorization = own(own(payload, 'payload'), 'permit2Authorization');
  const permitted = own(authorization, 'permitted');
  const witness = own(authorization, 'witness');
  const asset = addressOf(own(requirements, 'asset'));
  const payer = addressOf(own(authorization, 'from'));
  const payTo = addressOf(own(requirements, 'payTo'));
  const proxy = addressOf(own(authorization, 'spender'));
  const amount = amountOf(own(requirements, 'amount'));
  const nonce = amountOf(own(authorization, 'nonce'));
  if (asset === undefined || payer === undefined || payTo === undefined || proxy === undefined) {
    return undefined;
  }
  if (nonce === undefined) return undefined;
  if (amount === undefined || amountOf(own(permitted, 'amount')) !== amount) return undefined;
  if (addressOf(own(permitted, 'token')) !== asset || addressOf(own(witness, 'to')) !== payTo) {
    return undefined;
  }
  if (scheme === 'exact') return { method: 'permit2', asset, payer, payTo, proxy, nonce, amount };
  const facilitator = addressOf(own(witness, 'facilitator'));
  if (facilitator === undefined) return undefined;
  return { method: 'upto', asset, payer, payTo, proxy, nonce, facilitator, max: amount };
}

/** The check of a payment, or undefined for a scheme or authorization method without one (ADR 0017). */
function checkOf(requirements: object, payload: object): PaymentCheck | undefined {
  return eip3009CheckOf(requirements, payload) ?? permit2CheckOf(requirements, payload);
}

/**
 * Whether `receipt` carries the EIP-3009 payment: among the logs of its asset, `AuthorizationUsed` with the payer and
 * the nonce, and `Transfer` from the payer to the recipient of exactly the amount. Undefined when it cannot tell: no
 * receipt, or one that is not successful.
 */
function carriesEip3009Payment(receipt: unknown, check: Eip3009Check): boolean | undefined {
  if (own(receipt, 'status') !== 'success') return undefined;
  const logs = own(receipt, 'logs');
  if (!Array.isArray(logs)) return undefined;
  let authorized = false;
  let transferred = false;
  for (const log of logs) {
    const address = own(log, 'address');
    if (typeof address !== 'string' || address.toLowerCase() !== check.asset) continue;
    let event: { eventName: string; args: Record<string, unknown> };
    try {
      event = decodeEventLog({
        abi: EIP3009_EVENTS,
        data: own(log, 'data') as `0x${string}`,
        topics: own(log, 'topics') as [`0x${string}`, ...`0x${string}`[]],
      }) as typeof event;
    } catch {
      continue;
    }
    if (event.eventName === 'AuthorizationUsed') {
      authorized ||=
        lower(event.args.authorizer) === check.payer && lower(event.args.nonce) === check.nonce;
    } else if (event.eventName === 'Transfer') {
      transferred ||=
        lower(event.args.from) === check.payer &&
        lower(event.args.to) === check.payTo &&
        event.args.value === check.amount;
    }
  }
  return authorized && transferred;
}

/**
 * Whether `receipt` carries the Permit2 payment: the transaction calls the proxy (sent by the facilitator, for
 * `upto`), the proxy emitted `Settled` or `SettledWithPermit`, and the asset emitted `Transfer` from the payer to the
 * recipient of exactly the amount, or for `upto` of more than nothing, at most the maximum and, when the settlement
 * reported an amount, exactly that amount. Undefined when it cannot tell: no receipt, or one that is not successful.
 */
function carriesPermit2Payment(
  receipt: unknown,
  check: Permit2Check | UptoCheck,
  reported: PaymentSettlement['amount'],
): boolean | undefined {
  if (own(receipt, 'status') !== 'success') return undefined;
  const logs = own(receipt, 'logs');
  if (!Array.isArray(logs)) return undefined;
  if (lower(own(receipt, 'to')) !== check.proxy) return false;
  let expected: bigint | undefined;
  if (check.method === 'upto') {
    if (lower(own(receipt, 'from')) !== check.facilitator) return false;
    if (reported !== undefined) {
      expected = typeof reported === 'bigint' ? reported : amountOf(reported);
      // A reported amount that is not one cannot be the amount transferred.
      if (expected === undefined) return false;
    }
  }
  const amountMatches = (value: unknown): boolean => {
    if (typeof value !== 'bigint') return false;
    if (check.method === 'permit2') return value === check.amount;
    return value > 0n && value <= check.max && (expected === undefined || value === expected);
  };
  let settled = false;
  let transferred = false;
  for (const log of logs) {
    const address = lower(own(log, 'address'));
    const data = own(log, 'data') as `0x${string}`;
    const topics = own(log, 'topics') as [`0x${string}`, ...`0x${string}`[]];
    if (address === check.proxy) {
      try {
        decodeEventLog({ abi: PROXY_EVENTS, data, topics });
        settled = true;
      } catch {
        // Another event of the proxy, or one that does not decode.
      }
    }
    if (address === check.asset) {
      let event: { args: Record<string, unknown> };
      try {
        event = decodeEventLog({ abi: TRANSFER_EVENT, data, topics }) as typeof event;
      } catch {
        continue;
      }
      transferred ||=
        lower(event.args.from) === check.payer &&
        lower(event.args.to) === check.payTo &&
        amountMatches(event.args.value);
    }
  }
  return settled && transferred;
}

/**
 * Whether the input of a settlement transaction settles the Permit2 payment: a call of the proxy's `settle` or
 * `settleWithPermit` whose permit has the payer's nonce and whose owner is the payer. Permit2 uses a nonce of an owner
 * once, so a successful settlement with it is this payment and no other. Input that does not decode is false.
 */
function settlesPermit2Payment(input: unknown, check: Permit2Check | UptoCheck): boolean {
  if (typeof input !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(input)) return false;
  let call: { functionName: string; args: readonly unknown[] };
  try {
    call = decodeFunctionData({
      abi: check.method === 'upto' ? UPTO_PROXY_FUNCTIONS : EXACT_PROXY_FUNCTIONS,
      data: input as `0x${string}`,
    }) as typeof call;
  } catch {
    return false;
  }
  // settleWithPermit takes an EIP-2612 permit first; upto takes the amount after the Permit2 permit.
  const permitAt = call.functionName === 'settleWithPermit' ? 1 : 0;
  const ownerAt = permitAt + (check.method === 'upto' ? 2 : 1);
  const permit = call.args[permitAt] as { nonce?: unknown } | undefined;
  return permit?.nonce === check.nonce && lower(call.args[ownerAt]) === check.payer;
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
  /** How to check that the settlement transaction carries the payment; absent when there is no check. */
  check: PaymentCheck | undefined;
  /** The settlement, while the payment span waits for its transaction's receipt to be checked. */
  settled: { settlement: PaymentSettlement; endTime: Date } | undefined;
}

/**
 * Traces the payments an x402 client makes, as `payment` spans
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.10.0/docs/adr/0013-x402-payments.md). It registers hooks on the
 * `x402Client` (from `@x402/core/client`) that `@x402/fetch`, `@x402/axios` and `@x402/mcp` pay through, so pass
 * that client, not an `x402HTTPClient`. Call it once per client, right after creating it and before registering
 * hooks of your own, which could otherwise keep hashspan from seeing an outcome: a second call returns the first
 * handle, ignores its options and logs a `diag` warning. Its hooks never throw and never change a payment. x402 v2 payments on `eip155`
 * networks are traced; others are made untraced, with a warning.
 */
export function withHashspan(client: object, options: WithHashspanX402Options = {}): HashspanX402 {
  const {
    reader,
    confirmTimeoutMs,
    tracker: providedTracker,
    ...rest
  } = optionsOf(options) as WithHashspanX402Options;
  const tracker: TxTracker = providedTracker ?? createTxTracker(rest);
  // Confirmations reuse the viem adapter's receipt handling, on the same tracker.
  // The server chooses the settling transaction, and with it the contract whose revert text would be recorded: revert
  // reasons are replayed only when asked for (docs/adr/0013-x402-payments.md).
  const viem = withViemHashspan({
    ...rest,
    decodeRevertReason: rest.decodeRevertReason ?? false,
    tracker,
  });

  const starts = new WeakMap<object, Start>();
  // Insertion order is age, for MAX_OPEN_PAYMENTS.
  const open = new Map<object, OpenPayment>();
  // The open payment of a requirements object, for a creation failure reported after hashspan's after-hook ran.
  const byRequirements = new WeakMap<object, OpenPayment>();

  /** The input of the transaction `hash`, read through `client`, or undefined when it cannot be read in time. */
  const inputOf = (client: ViemClientLike, hash: string): Promise<unknown> =>
    new Promise((resolve) => {
      const done = (input: unknown): void => {
        timers.clearTimeout(timer);
        resolve(input);
      };
      const timer = timers.setTimeout(() => done(undefined), TRANSACTION_TIMEOUT_MS);
      // The timer must not keep a process alive that is otherwise done.
      (timer as { unref?: () => void } | undefined)?.unref?.();
      Promise.resolve()
        .then(() => client.request({ method: 'eth_getTransactionByHash', params: [hash] }))
        .then(
          (transaction: unknown) => done(own(transaction, 'input')),
          (error: unknown) => {
            diag.debug(`hashspan: could not read the settlement transaction (${errorName(error)})`);
            done(undefined);
          },
        );
    });

  /**
   * The verdict on `receipt` for a payment checked with `check`; undefined when no check was possible. For Permit2,
   * whose logs carry no nonce, a receipt that carries the payment is checked against the nonce in the input of the
   * receipt's own transaction, read through `client` (ADR 0017). That is the mined transaction, which is not the
   * reported one when it was replaced, so the receipt and the input always belong to one transaction.
   */
  const verdictOf = async (
    client: ViemClientLike,
    check: PaymentCheck,
    settlement: PaymentSettlement,
    receipt: unknown,
  ): Promise<boolean | undefined> => {
    if (check.method === 'eip3009') return carriesEip3009Payment(receipt, check);
    const carried = carriesPermit2Payment(receipt, check, settlement.amount);
    if (carried !== true) return carried;
    const mined = own(receipt, 'transactionHash');
    if (typeof mined !== 'string' || !TX_HASH.test(mined)) return undefined;
    const input = await inputOf(client, mined);
    return input === undefined ? undefined : settlesPermit2Payment(input, check);
  };

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
  /**
   * Ends a payment that cannot wait any longer: as `timeout` while it waits for its response, or with its settlement
   * and no verdict while it waits for the receipt to check.
   */
  const timeOut = (payment: OpenPayment): void => {
    const { settled } = payment;
    if (settled) {
      finish(payment, 'payment settlement', (handle) =>
        handle.end(settled.settlement, { endTime: settled.endTime }),
      );
      return;
    }
    finish(payment, 'payment timeout', (handle) => handle.timeout({ endTime: new Date() }));
  };

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
      check: checkOf(requirements, payload),
      settled: undefined,
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
    let settlement: PaymentSettlement;
    let network: unknown;
    try {
      settlement = settlementOf(response);
      network = own(response, 'network');
    } catch {
      // A response that cannot be read still ends the payment span, as `_OTHER` (ADR 0025 rule 1).
      diag.debug('hashspan: could not read the settlement response');
      finish(payment, 'unreadable settlement', (handle) => handle.fail(undefined, { endTime }));
      return;
    }
    const end = (verified?: boolean): void =>
      finish(payment, 'payment settlement', (handle) =>
        handle.end(verified === undefined ? settlement : { ...settlement, verified }, { endTime }),
      );
    const { hash } = settlement;
    if (settlement.status === 'failed' || hash === undefined || !TX_HASH.test(hash)) {
      end();
      return;
    }
    if (network !== undefined && chainIdOf(network) !== payment.chainId) {
      diag.warn(
        'hashspan: the settlement is on another network than the payment; not confirming it',
      );
      end();
      return;
    }
    const confirmWith = readerFor(payment.chainId);
    const { check, handle } = payment;
    // A tracker from a core before 0.6 cannot link an open payment span: it ends now, unchecked (ADR 0014).
    if (!confirmWith || !check || typeof handle.link !== 'function') {
      end();
      if (confirmWith) {
        viem.watch(confirmWith, { hash, chainId: payment.chainId, timeoutMs: confirmTimeoutMs });
      }
      return;
    }
    // The payment span ends once the receipt is checked, at the time the response came (ADR 0017).
    payment.settled = { settlement, endTime };
    timers.clearTimeout(payment.timer);
    try {
      handle.link(hash);
    } catch (error) {
      diag.error(`hashspan: failed to link the payment span (${errorName(error)})`);
    }
    viem.watch(confirmWith, {
      hash,
      chainId: payment.chainId,
      timeoutMs: confirmTimeoutMs,
      onReceipt: (receipt) => {
        if (receipt === undefined) {
          end();
          return;
        }
        void verdictOf(confirmWith, check, settlement, receipt)
          .then((verified) => end(verified))
          .catch((error: unknown) => {
            diag.error(`hashspan: failed to check the settlement (${errorName(error)})`);
            end();
          });
      },
    });
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
      const deadline = Date.now() + flushTimeoutOf(flushOptions);
      try {
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
  let existing: unknown;
  let hooksFound: boolean;
  try {
    existing = own(target, WRAPPED as unknown as string) ?? target[WRAPPED];
    hooksFound = HOOKS.every((name) => typeof target[name] === 'function');
  } catch {
    // A client that cannot be read is not traced; withHashspan() never throws into the caller (ADR 0025 rule 1).
    diag.warn('hashspan: not tracing x402 payments: the client cannot be read');
    return noop;
  }
  if (isObject(existing)) {
    diag.warn(
      'hashspan: this x402 client is already traced; ignoring the options of the second withHashspan()',
    );
    return existing as HashspanX402;
  }
  if (!hooksFound) {
    diag.warn(
      'hashspan: not tracing x402 payments: pass the x402Client (with onPaymentResponse, @x402/core 2.13 or later), not an x402HTTPClient',
    );
    return noop;
  }
  if (!hasStartPayment(tracker)) {
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
