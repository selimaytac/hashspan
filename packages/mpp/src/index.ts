import {
  createTxTracker,
  type PaymentHandle,
  type PaymentInput,
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
import { decodeEventLog, fromRlp, keccak256, parseAbi, stringToBytes } from 'viem';

/**
 * Options of {@link withHashspan}: those of `@hashspan/viem`'s `withHashspan()` except `confirm`, and the reader to
 * confirm settlements with. They are read once, from the object's own enumerable properties; options it inherits
 * through a prototype, such as the getters of a class instance, are ignored
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.2/docs/adr/0025-untrusted-input.md).
 */
export interface WithHashspanMppOptions extends Omit<ViemOptions, 'confirm'> {
  /**
   * viem public client(s) to confirm settlements with: one client, used for every chain it is on, or a function
   * returning the client for a chain id. Without a reader, only payment spans are recorded, with the settlement as the
   * server reported it; the adapter never chooses an RPC endpoint itself.
   */
  reader?: ViemClientLike | ((chainId: number) => ViemClientLike | undefined) | undefined;
  /** How long to poll for the receipt of a settlement before the confirm span ends as `timeout`. Default: 120 000 ms. */
  confirmTimeoutMs?: number | undefined;
  /**
   * Replay reverted settlements to record their revert reason, as in `@hashspan/viem`. Default: false: a pull
   * settlement is broadcast by the server you pay. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.2/docs/adr/0029-mpp-payments.md.
   */
  decodeRevertReason?: ViemOptions['decodeRevertReason'];
  /**
   * Also observe mppx's `payment.failed` event, so a payment answered with a 5xx, or whose paid request threw, ends as
   * `pending` with its hash, and one that failed before its credential (policy, signing, a failed push send) as an
   * error. Default: false. With it, mppx buffers the body of a 5xx paid response for the observer, at most 64 KiB and
   * 2 seconds: a longer body reaches you cut, with an `Mppx-Body-Truncated: true` header, and a body whose stream fails
   * makes `fetch` reject. Without it, nothing changes what you get: such payments end as `timeout`, keeping the payer's
   * hash, and with a reader the confirm span records the transaction
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.2/docs/adr/0029-mpp-payments.md).
   */
  observeFailures?: boolean | undefined;
}

/** Returned by {@link withHashspan}; the mppx client itself gets observers, nothing is replaced. */
export interface HashspanMpp {
  /**
   * Waits for tracing work still running after paid requests returned (paid payments without an outcome yet, then
   * confirmations through the reader), so their spans are ended before the OpenTelemetry SDK shuts down; a challenge
   * that was never paid is not waited for. Resolves true
   * when all of it finished, false on timeout (default 10 000 ms), ending payment spans still open as `timeout`; never
   * rejects. See https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.2/docs/adr/0010-flush-before-shutdown.md.
   */
  flush(options?: FlushOptions): Promise<boolean>;
}

const WRAPPED = Symbol.for('hashspan.mpp.wrapped');
const EVENTS = [
  'challenge.received',
  'credential.created',
  'payment.response',
  'payment.failed',
] as const;
/**
 * The events observed by default. Observing `payment.failed` makes mppx buffer 5xx bodies, which changes what the
 * caller gets, so it is observed only with `observeFailures` (ADR 0029).
 */
const DEFAULT_EVENTS: readonly (typeof EVENTS)[number][] = EVENTS.filter(
  (name) => name !== 'payment.failed',
);
// The same default as @hashspan/viem's flush().
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
/** How long a payment may wait for its outcome: the challenge's validity, else mppx's default of 25 s, plus a grace. */
const DEFAULT_VALIDITY_MS = 25_000;
const GRACE_MS = 30_000;
const MAX_DEADLINE_MS = 60 * 60 * 1000;
/** Payments waiting for an outcome, counted from their challenge; when more are open, the oldest ends as `timeout`. */
const MAX_OPEN_PAYMENTS = 1000;
/** The longest challenge id the adapter follows a payment by; a longer one is not traced. */
const MAX_CHALLENGE_ID_LENGTH = 1024;
/** The longest credential and `Payment-Receipt` header the adapter decodes. */
const MAX_CREDENTIAL_LENGTH = 65_536;
const MAX_RECEIPT_LENGTH = 4096;
/** At most this many splits a Tempo charge has (mppx's own schema); a challenge with more is not checked. */
const MAX_SPLITS = 10;
const MAX_WARNINGS = 32;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
/** A JSON-RPC quantity of at most 32 bytes, without leading zeros. */
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
/** How long to wait for the transaction of a sponsored pull's settlement, to read its nonce. */
const TRANSACTION_TIMEOUT_MS = 10_000;
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
/** A credential as mppx serializes it: the `Payment` scheme and base64url JSON. */
const CREDENTIAL = /^Payment\s+([A-Za-z0-9_-]+={0,2})$/i;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
/** The source mppx writes into a credential: `did:pkh:eip155:<chainId>:<address>`. */
const PKH_SOURCE = /^did:pkh:eip155:([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})$/;
const NO_SETTLEMENT = 'no_settlement';
const OUTCOME_UNKNOWN = 'PaymentOutcomeUnknownError';
/** The events of a TIP-20 transfer; decoded with this ABI only, never a caller's. */
const TIP20_EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
]);
/** mppx's attribution memo: bytes 0 to 3 the tag `keccak256("mpp")`, byte 4 the version. */
const MEMO_TAG = keccak256(stringToBytes('mpp')).slice(2, 10);
const MEMO_VERSION = '01';
// Timers, base64 and UTF-8 decoding without Node.js or DOM types, which src/ is type-checked without.
const platform = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  atob?: (data: string) => string;
  TextDecoder?: new () => { decode(bytes: Uint8Array): string };
  Response?: abstract new (...args: never[]) => object;
  Request?: abstract new (...args: never[]) => object;
  URL?: abstract new (...args: never[]) => object;
  Headers?: abstract new (...args: never[]) => object;
  ReadableStream?: abstract new (...args: never[]) => object;
};

/** Timers, read from the platform when called, so that a replaced `setTimeout` (such as a test's) is the one used. */
const timers = {
  setTimeout: (callback: () => void, ms: number): unknown => platform.setTimeout(callback, ms),
  clearTimeout: (timer: unknown): void => platform.clearTimeout(timer),
};

/** An error name `diag` messages include: short text, as a class name is. */
const ERROR_NAME = /^[A-Za-z0-9_.$-]{1,64}$/;

/** What `diag` logs for an error: its name, if it is short text. Never throws, also for a name that cannot be read. */
function errorName(error: unknown): string {
  try {
    const name: unknown = error instanceof Error ? error.name : undefined;
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

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` lower-cased when it is an address, else undefined. */
function addressOf(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : undefined;
}

/** `value` as an amount when it is a decimal string, else undefined. */
function amountOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && AMOUNT.test(value) ? BigInt(value) : undefined;
}

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

/**
 * Whether `tracker` reads `PaymentInput.sender`, `hash` and `mpp` (core 1.2 and later): without them, a payment span
 * would label the payer's fee a facilitator's (ADR 0014, ADR 0029). A tracker that cannot be read does not.
 */
function readsPayerSettlements(tracker: TxTracker): boolean {
  try {
    const senders: unknown = (tracker as { paymentSenders?: unknown }).paymentSenders;
    return (
      typeof tracker.startPayment === 'function' &&
      Array.isArray(senders) &&
      senders.includes('payer')
    );
  } catch {
    diag.debug('hashspan: could not read the tracker');
    return false;
  }
}

/** The getter `key` of the platform class `type`'s prototype, called on `target`, which must be one of its instances. */
function native(type: keyof typeof platform, target: unknown, key: string): unknown {
  const Class = platform[type] as (abstract new (...args: never[]) => object) | undefined;
  if (typeof Class !== 'function' || !(target instanceof Class)) return undefined;
  const getter = Object.getOwnPropertyDescriptor(Class.prototype, key)?.get;
  return getter ? Reflect.apply(getter, target, []) : undefined;
}

/**
 * The URL of a paid request's input: a string as it is, the `href` of a `URL` and the `url` of a `Request`, read
 * through their native accessors (ADR 0029: platform objects are recognised with `instanceof`).
 */
function resourceOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  return stringOrUndefined(native('URL', input, 'href') ?? native('Request', input, 'url'));
}

/** The `Payment-Receipt` header of a `Response`, read through the native `headers` and `Headers.get`. */
function receiptHeaderOf(response: unknown): string | null | undefined {
  const headers = native('Response', response, 'headers');
  const Headers = platform.Headers;
  if (typeof Headers !== 'function' || !(headers instanceof Headers)) return undefined;
  const get = (Headers.prototype as { get?: unknown }).get;
  if (typeof get !== 'function') return undefined;
  const value: unknown = Reflect.apply(get, headers, ['payment-receipt']);
  return typeof value === 'string' ? value : null;
}

/**
 * Cancels the body of `response`, a copy mppx made for observers, unless someone started reading it; ignores a
 * rejected cancel. Read through the native accessors of `Response` and `ReadableStream`.
 */
function releaseCopy(response: unknown): void {
  try {
    if (native('Response', response, 'bodyUsed') !== false) return;
    const body = native('Response', response, 'body');
    if (native('ReadableStream', body, 'locked') !== false) return;
    const cancel = (platform.ReadableStream?.prototype as { cancel?: unknown } | undefined)?.cancel;
    if (typeof cancel !== 'function') return;
    const cancelled: unknown = Reflect.apply(cancel, body, []);
    if (cancelled instanceof Promise) cancelled.catch(() => {});
  } catch (error) {
    diag.debug(`hashspan: could not release the copy of a paid response (${errorName(error)})`);
  }
}

/** The JSON of base64url `encoded`, at most `max` characters long; undefined when it is none. */
function base64urlJson(encoded: string, max: number): unknown {
  if (encoded.length > max || !BASE64URL.test(encoded)) return undefined;
  const { atob, TextDecoder } = platform;
  if (typeof atob !== 'function' || typeof TextDecoder !== 'function') return undefined;
  try {
    const unpadded = encoded.replace(/=+$/, '');
    const base64 = unpadded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The nonce and validity fields the payer signed into a Tempo transaction. A Tempo node accepts a transaction with
 * them once, so the mined transaction that carries them is the one the payer signed.
 */
interface SignedNonce {
  nonceKey: bigint;
  nonce: bigint;
  validBefore: bigint;
  validAfter: bigint;
}

/** What the adapter reads from a credential, which the payer's own client wrote. */
interface CredentialFields {
  /** `push` for a hash credential, `pull` for a signed transaction, `proof` for a zero-amount proof. */
  type: 'push' | 'pull' | 'proof' | undefined;
  /** The settlement's hash, when the credential determines it (push, unsponsored pull). */
  hash: string | undefined;
  /** The signed nonce and validity fields of a pull, when its transaction decodes and carries them all. */
  signed: SignedNonce | undefined;
  chainId: number | undefined;
  payer: string | undefined;
}

const NO_CREDENTIAL: CredentialFields = {
  type: undefined,
  hash: undefined,
  signed: undefined,
  chainId: undefined,
  payer: undefined,
};

/** Decodes a credential string; a credential that is not one, or too long, gives nothing. */
function credentialFieldsOf(credential: unknown): CredentialFields {
  if (typeof credential !== 'string' || credential.length > MAX_CREDENTIAL_LENGTH) {
    return NO_CREDENTIAL;
  }
  const match = CREDENTIAL.exec(credential);
  const json = match ? base64urlJson(match[1] as string, MAX_CREDENTIAL_LENGTH) : undefined;
  if (!isObject(json)) return NO_CREDENTIAL;
  const payload = own(json, 'payload');
  const kind = own(payload, 'type');
  const source = stringOrUndefined(own(json, 'source'));
  const parsed = source !== undefined ? PKH_SOURCE.exec(source) : null;
  const chainId = parsed ? Number(parsed[1]) : undefined;
  const fields = {
    chainId: chainId !== undefined && Number.isSafeInteger(chainId) ? chainId : undefined,
    payer: parsed ? (parsed[2] as string).toLowerCase() : undefined,
  };
  if (kind === 'hash') {
    const hash = own(payload, 'hash');
    return {
      type: 'push',
      hash: typeof hash === 'string' && TX_HASH.test(hash) ? hash.toLowerCase() : undefined,
      signed: undefined,
      ...fields,
    };
  }
  if (kind === 'transaction') {
    const signed = signedTransactionOf(own(payload, 'signature'));
    return { type: 'pull', hash: signed?.hash, signed: signed?.nonce, ...fields };
  }
  if (kind === 'proof') return { type: 'proof', hash: undefined, signed: undefined, ...fields };
  return { ...NO_CREDENTIAL, ...fields };
}

type RlpItem = string | RlpItem[];

/** Whether `value` is an RLP byte string that encodes an integer canonically: no leading zero byte. */
function isMinimalInteger(value: RlpItem | undefined): boolean {
  return typeof value === 'string' && (value === '0x' || !value.startsWith('0x00'));
}

/** An RLP integer field of at most 32 bytes as a bigint, `0x` as zero; undefined for anything else. */
function rlpInteger(value: RlpItem | undefined): bigint | undefined {
  if (!isMinimalInteger(value) || (value as string).length > 66) return undefined;
  return value === '0x' ? 0n : BigInt(value as string);
}

/**
 * What a pull credential's signed Tempo transaction fixes: its nonce and validity fields, and the hash it will have
 * on chain when no fee payer changes it. The hash is mppx's (`transactionHash` in `tempo/client/Charge.js`): the
 * `keccak256` of a `0x76` envelope signed by the payer, without a fee payer marker, serialized canonically; undefined
 * for a transaction that waits for a fee payer's signature (a `0x76` envelope with a fee payer marker, or the `0x78`
 * envelope mppx sends the fee payer), which changes the hash (ADR 0029). The nonce fields are undefined unless all
 * four are there, a validity bound of `0x` counting as missing. Undefined for a transaction that does not decode.
 */
function signedTransactionOf(
  serialized: unknown,
): { hash: string | undefined; nonce: SignedNonce | undefined } | undefined {
  if (typeof serialized !== 'string' || serialized.length > MAX_CREDENTIAL_LENGTH) return undefined;
  const envelope = serialized.slice(0, 4).toLowerCase();
  if (!HEX.test(serialized) || (envelope !== '0x76' && envelope !== '0x78')) return undefined;
  let fields: RlpItem;
  try {
    // fromRlp rejects trailing bytes and lengths that do not add up.
    fields = fromRlp(`0x${serialized.slice(4)}`, 'hex') as RlpItem;
  } catch {
    return undefined;
  }
  if (!Array.isArray(fields) || fields.length < 13 || fields.length > 15) return undefined;
  // chainId, maxPriorityFeePerGas, maxFeePerGas, gas, nonceKey, nonce, validBefore, validAfter.
  if (![0, 1, 2, 3, 6, 7, 8, 9].every((index) => isMinimalInteger(fields[index]))) return undefined;
  if (!Array.isArray(fields[4]) || !Array.isArray(fields[5]) || !Array.isArray(fields[12])) {
    return undefined;
  }
  const keyAuthorization = Array.isArray(fields[13]);
  const signature = keyAuthorization ? fields[14] : fields[13];
  if (fields.length !== (keyAuthorization ? 15 : 14)) return undefined;
  if (typeof signature !== 'string' || signature === '0x') return undefined;
  // In a `0x76` envelope: `0x` without a fee payer, `0x00` or an address for a transaction that waits for one, a list
  // for the fee payer's signature. In a `0x78` envelope: the sender's address.
  const feePayer = fields[11];
  const final = envelope === '0x76' && (feePayer === '0x' || Array.isArray(feePayer));
  const waiting =
    typeof feePayer === 'string' &&
    (ADDRESS.test(feePayer) || (envelope === '0x76' && feePayer === '0x00'));
  if (!final && !waiting) return undefined;
  const [nonceKey, nonce, validBefore, validAfter] = [6, 7, 8, 9].map((index) =>
    rlpInteger(fields[index]),
  );
  const complete =
    nonceKey !== undefined &&
    nonce !== undefined &&
    validBefore !== undefined &&
    validBefore !== 0n &&
    validAfter !== undefined &&
    validAfter !== 0n;
  return {
    hash: final ? keccak256(serialized as `0x${string}`).toLowerCase() : undefined,
    nonce: complete ? { nonceKey, nonce, validBefore, validAfter } : undefined,
  };
}

/** A JSON-RPC quantity of at most 32 bytes, written canonically, as a bigint; undefined for anything else. */
function quantityOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && QUANTITY.test(value) ? BigInt(value) : undefined;
}

/**
 * Whether `transaction`, as a node returns it for `eth_getTransactionByHash`, is the one the payer signed: sent by
 * `payer`, with the nonce and validity fields of `signed`. A Tempo node accepts a transaction with them once.
 */
function isSignedTransaction(transaction: unknown, payer: string, signed: SignedNonce): boolean {
  return (
    addressOf(own(transaction, 'from')) === payer &&
    quantityOf(own(transaction, 'nonceKey')) === signed.nonceKey &&
    quantityOf(own(transaction, 'nonce')) === signed.nonce &&
    quantityOf(own(transaction, 'validBefore')) === signed.validBefore &&
    quantityOf(own(transaction, 'validAfter')) === signed.validAfter
  );
}

/** What the server reported in its `Payment-Receipt`. */
interface ReportedReceipt {
  /** The settlement's hash, when the reference is one. */
  reference: string | undefined;
  fundingCurrency: string | undefined;
}

/** Decodes a `Payment-Receipt` header; undefined for one that is not a successful receipt, or too long. */
function reportedReceiptOf(header: string): ReportedReceipt | undefined {
  const json = base64urlJson(header.trim(), MAX_RECEIPT_LENGTH);
  if (!isObject(json) || Array.isArray(json) || own(json, 'status') !== 'success') return undefined;
  const reference = own(json, 'reference');
  const funding = own(json, 'fundingCurrency');
  return {
    reference:
      typeof reference === 'string' && TX_HASH.test(reference)
        ? reference.toLowerCase()
        : undefined,
    fundingCurrency: typeof funding === 'string' ? funding.toLowerCase() : undefined,
  };
}

/** The payment details of a challenge's `request`, as the adapter reads them; addresses lower-cased when valid. */
interface ChargeRequest {
  amount: string | undefined;
  currency: string | undefined;
  recipient: string | undefined;
  chainId: number | undefined;
  splits: unknown;
}

function chargeRequestOf(challenge: unknown): ChargeRequest {
  const request = own(challenge, 'request');
  const details = own(request, 'methodDetails');
  const chainId = own(details, 'chainId');
  return {
    amount: stringOrUndefined(own(request, 'amount')),
    currency: stringOrUndefined(own(request, 'currency')),
    recipient: stringOrUndefined(own(request, 'recipient')),
    chainId:
      typeof chainId === 'number' && Number.isSafeInteger(chainId) && chainId > 0
        ? chainId
        : undefined,
    splits: own(details, 'splits'),
  };
}

/** How long to wait for the outcome of a payment for `challenge`: its validity, plus a grace period, bounded. */
function deadlineMs(challenge: unknown): number {
  const expires = own(challenge, 'expires');
  const at = typeof expires === 'string' ? Date.parse(expires) : Number.NaN;
  const validity = Number.isFinite(at) ? Math.max(at - Date.now(), 0) : DEFAULT_VALIDITY_MS;
  return Math.min(validity + GRACE_MS, MAX_DEADLINE_MS);
}

/** What identifies a Tempo charge in its settlement's receipt, all from the challenge and the payer's credential. */
interface ChargeCheck {
  currency: string;
  payer: string;
  /** The primary transfer: to the recipient, of the amount less the splits, with the challenge's memo. */
  recipient: string;
  amount: bigint;
  /** Bytes 0 to 14 of the memo (tag, version, realm fingerprint) and bytes 25 to 31 (the challenge's nonce), as hex. */
  memoPrefix: string;
  memoNonce: string;
  splits: { recipient: string; amount: bigint; memo: string | undefined }[];
}

/** The check of a charge, or undefined when a value it needs does not validate or cannot be read. */
function chargeCheckOf(
  challenge: unknown,
  request: ChargeRequest,
  payer: string | undefined,
): ChargeCheck | undefined {
  try {
    return readChargeCheck(challenge, request, payer);
  } catch {
    diag.debug('hashspan: could not read the challenge to check its settlement');
    return undefined;
  }
}

function readChargeCheck(
  challenge: unknown,
  request: ChargeRequest,
  payer: string | undefined,
): ChargeCheck | undefined {
  const id = own(challenge, 'id');
  const realm = own(challenge, 'realm');
  const currency = addressOf(request.currency);
  const recipient = addressOf(request.recipient);
  const total = amountOf(request.amount);
  if (
    payer === undefined ||
    currency === undefined ||
    recipient === undefined ||
    total === undefined
  ) {
    return undefined;
  }
  if (typeof id !== 'string' || typeof realm !== 'string') return undefined;
  const splits: ChargeCheck['splits'] = [];
  if (request.splits !== undefined) {
    if (!Array.isArray(request.splits) || request.splits.length > MAX_SPLITS) return undefined;
    for (const split of request.splits) {
      const to = addressOf(own(split, 'recipient'));
      const amount = amountOf(own(split, 'amount'));
      const memo = own(split, 'memo');
      if (to === undefined || amount === undefined || amount === 0n) return undefined;
      if (memo !== undefined && (typeof memo !== 'string' || !TX_HASH.test(memo))) return undefined;
      splits.push({ recipient: to, amount, memo: stringOrUndefined(memo)?.toLowerCase() });
    }
  }
  const amount = total - splits.reduce((sum, split) => sum + split.amount, 0n);
  if (amount <= 0n) return undefined;
  const realmPrint = keccak256(stringToBytes(realm)).slice(2, 22);
  return {
    currency,
    payer,
    recipient,
    amount,
    memoPrefix: `${MEMO_TAG}${MEMO_VERSION}${realmPrint}`,
    memoNonce: keccak256(stringToBytes(id)).slice(2, 16),
    splits,
  };
}

/** One transfer of a receipt: a `Transfer`, or a `TransferWithMemo` paired with the `Transfer` beside it. */
interface TransferEffect {
  from: unknown;
  to: unknown;
  amount: unknown;
  memo: string | undefined;
}

/**
 * The transfers of `currency` among `logs`, paired as mppx's server pairs them (`getTransferLogEffects`): a
 * `Transfer` and a `TransferWithMemo` of the same transfer, adjacent in log index, are one transfer with a memo. Logs
 * that do not decode are skipped.
 */
function transfersOf(logs: readonly unknown[], currency: string): TransferEffect[] {
  const decoded: (TransferEffect & { kind: 'transfer' | 'memo'; index: number })[] = [];
  for (const [position, log] of logs.entries()) {
    if (lowerOf(own(log, 'address')) !== currency) continue;
    let event: { eventName: string; args: Record<string, unknown> };
    try {
      event = decodeEventLog({
        abi: TIP20_EVENTS,
        data: own(log, 'data') as `0x${string}`,
        topics: own(log, 'topics') as [`0x${string}`, ...`0x${string}`[]],
      }) as typeof event;
    } catch {
      continue;
    }
    const logIndex = own(log, 'logIndex');
    decoded.push({
      kind: event.eventName === 'TransferWithMemo' ? 'memo' : 'transfer',
      index: typeof logIndex === 'number' && Number.isSafeInteger(logIndex) ? logIndex : position,
      from: lowerOf(event.args.from),
      to: lowerOf(event.args.to),
      amount: event.args.amount,
      memo: stringOrUndefined(event.args.memo)?.toLowerCase(),
    });
  }
  decoded.sort((a, b) => a.index - b.index);
  const effects: TransferEffect[] = [];
  for (let at = 0; at < decoded.length; at++) {
    const log = decoded[at] as (typeof decoded)[number];
    const next = decoded[at + 1];
    if (
      next &&
      next.kind !== log.kind &&
      next.from === log.from &&
      next.to === log.to &&
      next.amount === log.amount &&
      Math.abs(next.index - log.index) === 1
    ) {
      effects.push({ ...(log.kind === 'memo' ? log : next) });
      at++;
      continue;
    }
    effects.push({ ...log, memo: log.kind === 'memo' ? log.memo : undefined });
  }
  return effects;
}

const lowerOf = (value: unknown): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

/**
 * Whether `receipt` carries the charge: among its transfers of the currency, each matched to a distinct one, the
 * primary transfer from the payer with the challenge's memo, and one transfer from the payer per split. Undefined when
 * it cannot tell: no receipt, or one that is not successful.
 */
function carriesCharge(receipt: unknown, check: ChargeCheck): boolean | undefined {
  if (own(receipt, 'status') !== 'success') return undefined;
  const logs = own(receipt, 'logs');
  if (!Array.isArray(logs)) return undefined;
  const effects = transfersOf(logs, check.currency);
  const used = new Set<number>();
  const take = (matches: (effect: TransferEffect) => boolean): boolean => {
    const found = effects.findIndex((effect, index) => !used.has(index) && matches(effect));
    if (found === -1) return false;
    used.add(found);
    return true;
  };
  const primary = take(
    (effect) =>
      effect.from === check.payer &&
      effect.to === check.recipient &&
      effect.amount === check.amount &&
      typeof effect.memo === 'string' &&
      effect.memo.slice(2, 32) === check.memoPrefix &&
      effect.memo.slice(52, 66) === check.memoNonce,
  );
  if (!primary) return false;
  // Splits with a memo first, as mppx matches them, so a split without one cannot take a transfer that has it.
  const splits = [...check.splits].sort(
    (a, b) => Number(b.memo !== undefined) - Number(a.memo !== undefined),
  );
  return splits.every((split) =>
    take(
      (effect) =>
        effect.from === check.payer &&
        effect.to === split.recipient &&
        effect.amount === split.amount &&
        (split.memo === undefined || effect.memo === split.memo),
    ),
  );
}

/** A payment from its challenge on, followed by the challenge's id. */
interface Payment {
  id: string;
  startTime: Date;
  parent: Context;
  challenge: object;
  resource: string | undefined;
  timer: unknown;
  ended: boolean;
  done: Promise<void>;
  resolve: () => void;
  /** Set once the credential is created and the payment span started. */
  started:
    | {
        handle: PaymentHandle;
        credential: string;
        chainId: number;
        fields: CredentialFields;
        request: ChargeRequest;
      }
    | undefined;
  /** The settlement, while the payment span waits for its transaction's receipt to be checked. */
  settled: { settlement: PaymentSettlement; endTime: Date } | undefined;
}

/**
 * Traces the payments an mppx client makes, as `payment` spans
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.2/docs/adr/0029-mpp-payments.md). It registers observers with
 * `on()` on the client `Mppx.create()` from `mppx/client` returns, which every payment made through its `fetch`, or the
 * global `fetch` it polyfills, reaches. Call it once per client: a second call returns the first handle, ignores its
 * options and logs a `diag` warning. Its observers never throw, never return a value and never change a payment.
 * Tempo `charge` payments are traced, push and pull; other methods and intents are made untraced, with a warning.
 */
export function withHashspan(client: object, options: WithHashspanMppOptions = {}): HashspanMpp {
  const {
    reader,
    confirmTimeoutMs,
    observeFailures,
    tracker: providedTracker,
    ...rest
  } = optionsOf(options) as WithHashspanMppOptions;
  const tracker: TxTracker = providedTracker ?? createTxTracker(rest);
  // Confirmations reuse the viem adapter's receipt handling, on the same tracker. The server broadcasts a pull
  // settlement: revert reasons are replayed only when asked for (docs/adr/0029-mpp-payments.md).
  const viem = withViemHashspan({
    ...rest,
    decodeRevertReason: rest.decodeRevertReason ?? false,
    tracker,
  });

  // Insertion order is age, for MAX_OPEN_PAYMENTS.
  const open = new Map<string, Payment>();

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

  /**
   * Ends `payment` once with `record`, on its span's handle (default: the one started with its credential); the
   * payment is no longer open afterwards. Without a handle, nothing is recorded.
   */
  const finish = (
    payment: Payment,
    what: string,
    record?: (handle: PaymentHandle) => void,
    handle: PaymentHandle | undefined = payment.started?.handle,
  ): void => {
    if (payment.ended) return;
    payment.ended = true;
    timers.clearTimeout(payment.timer);
    if (open.get(payment.id) === payment) open.delete(payment.id);
    payment.resolve();
    if (!handle || !record) return;
    try {
      record(handle);
    } catch (error) {
      diag.error(`hashspan: failed to record ${what} (${errorName(error)})`);
    }
  };
  /**
   * Ends a payment that cannot wait any longer: as `timeout` while it waits for its outcome, with its settlement and no
   * verdict while it waits for the receipt to check, and with nothing recorded before its credential was created.
   */
  const timeOut = (payment: Payment): void => {
    const { settled } = payment;
    if (settled) {
      finish(payment, 'payment settlement', (handle) =>
        handle.end(settled.settlement, { endTime: settled.endTime }),
      );
      return;
    }
    finish(payment, 'payment timeout', (handle) => handle.timeout({ endTime: new Date() }));
  };

  /**
   * Ends a payment whose deadline passed without an outcome event, as `timeout`. When the payer knows its hash, the
   * money may have moved (a 4xx or 5xx after payment): with a reader, the confirm span records the transaction.
   */
  const expire = (payment: Payment): void => {
    const started = payment.started;
    const waiting = payment.ended || payment.settled ? undefined : started;
    timeOut(payment);
    const hash = waiting?.fields.hash;
    if (!waiting || hash === undefined) return;
    const confirmWith = readerFor(waiting.chainId);
    if (confirmWith) {
      viem.watch(confirmWith, { hash, chainId: waiting.chainId, timeoutMs: confirmTimeoutMs });
    }
  };

  /** The transaction `hash`, read through `client`, or undefined when it cannot be read in time. */
  const transactionOf = (client: ViemClientLike, hash: string): Promise<unknown> =>
    new Promise((resolve) => {
      const done = (transaction: unknown): void => {
        timers.clearTimeout(timer);
        resolve(transaction);
      };
      const timer = timers.setTimeout(() => done(undefined), TRANSACTION_TIMEOUT_MS);
      // The timer must not keep a process alive that is otherwise done.
      (timer as { unref?: () => void } | undefined)?.unref?.();
      Promise.resolve()
        .then(() => client.request({ method: 'eth_getTransactionByHash', params: [hash] }))
        .then(done, (error: unknown) => {
          diag.debug(`hashspan: could not read the settlement transaction (${errorName(error)})`);
          done(undefined);
        });
    });

  /**
   * The verdict on `receipt` for a payment checked with `check`. When the server named the settlement (a sponsored
   * pull), a receipt that carries the charge is `true` only when its own transaction, read through `client`, is the
   * one the payer signed; else there is no verdict (ADR 0029). The receipt's transaction is the mined one, so the
   * receipt and the transaction always belong together.
   */
  const verdictOf = async (
    client: ViemClientLike,
    check: ChargeCheck,
    signed: SignedNonce | undefined,
    receipt: unknown,
  ): Promise<boolean | undefined> => {
    const carried = carriesCharge(receipt, check);
    if (carried !== true || signed === undefined) return carried;
    const mined = own(receipt, 'transactionHash');
    if (typeof mined !== 'string' || !TX_HASH.test(mined)) return undefined;
    const transaction = await transactionOf(client, mined);
    return isSignedTransaction(transaction, check.payer, signed) ? true : undefined;
  };

  /** The payment of an event's challenge, when it is open. */
  const paymentOf = (payload: unknown): Payment | undefined => {
    const id = own(own(payload, 'challenge'), 'id');
    return typeof id === 'string' ? open.get(id) : undefined;
  };

  /** Starts the payment span of `payment`, with what its credential (if any) says. */
  const startSpan = (payment: Payment, fields: CredentialFields): PaymentHandle | undefined => {
    const request = chargeRequestOf(payment.challenge);
    const chainId = fields.chainId ?? request.chainId;
    if (chainId === undefined) {
      diag.debug('hashspan: an MPP payment without a chain id; not recording it');
      return undefined;
    }
    const input: PaymentInput = {
      chainId,
      protocol: 'mpp',
      sender: 'payer',
      hash: fields.hash,
      payer: fields.payer,
      recipient: request.recipient,
      asset: request.currency,
      amount:
        request.amount !== undefined && AMOUNT.test(request.amount) ? request.amount : undefined,
      mpp: {
        method: 'tempo',
        intent: 'charge',
        mode: fields.type === 'push' || fields.type === 'pull' ? fields.type : undefined,
        challengeId: payment.id,
        resource: payment.resource,
      },
      startTime: payment.startTime,
    };
    return tracker.startPayment(input, payment.parent);
  };

  /**
   * Ends a payment whose event could not be read: as `_OTHER` once its span started (ADR 0025 rule 1), with its
   * settlement while it waits for the receipt check, and with nothing recorded before its credential was created.
   */
  const unreadable = (payment: Payment): void => {
    if (payment.settled) {
      timeOut(payment);
      return;
    }
    finish(payment, 'unreadable payment event', (handle) =>
      handle.fail(undefined, { endTime: new Date() }),
    );
  };

  /**
   * Runs an observer body; an observer returns nothing and never throws, so it cannot change or fail the payment. The
   * body names the payment it works on with `follow`: if the body fails, that payment ends rather than waiting.
   */
  const observer =
    (what: string, body: (payload: unknown, follow: (payment: Payment) => void) => void) =>
    (payload: unknown): undefined => {
      let followed: Payment | undefined;
      try {
        body(payload, (payment) => {
          followed = payment;
        });
      } catch (error) {
        diag.error(`hashspan: failed to ${what} (${errorName(error)})`);
        if (followed) unreadable(followed);
      }
      return undefined;
    };

  /** The URL of the paid request's input, or undefined for one that cannot be read. */
  const safeResourceOf = (input: unknown): string | undefined => {
    try {
      return resourceOf(input);
    } catch {
      diag.debug('hashspan: could not read the URL of a paid request');
      return undefined;
    }
  };

  const challengeReceived = observer('record the start of a payment', (payload) => {
    const challenge = own(payload, 'challenge');
    if (!isObject(challenge)) return;
    const id = own(challenge, 'id');
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CHALLENGE_ID_LENGTH) {
      warnOnce('id', 'hashspan: not tracing an MPP payment whose challenge has no usable id');
      return;
    }
    // A repeated challenge keeps the first start time.
    if (open.has(id)) return;
    const method = own(challenge, 'method');
    const intent = own(challenge, 'intent');
    if (method !== 'tempo' || intent !== 'charge') {
      const name =
        typeof method === 'string' &&
        IDENTIFIER.test(method) &&
        typeof intent === 'string' &&
        IDENTIFIER.test(intent)
          ? `${method}.${intent}`
          : 'an unknown method';
      warnOnce(
        `method:${name}`,
        `hashspan: not tracing MPP payments of ${name}; only tempo.charge is traced`,
      );
      return;
    }
    // A zero-amount challenge is answered with a signed proof: no value moves.
    if (chargeRequestOf(challenge).amount === '0') return;
    if (open.size >= MAX_OPEN_PAYMENTS) {
      const oldest = open.values().next().value;
      if (oldest) timeOut(oldest);
    }
    let resolve = (): void => {};
    const done = new Promise<void>((resolveDone) => {
      resolve = resolveDone;
    });
    const payment: Payment = {
      id,
      startTime: new Date(),
      parent: context.active(),
      challenge,
      resource: safeResourceOf(own(payload, 'input')),
      timer: undefined,
      ended: false,
      done,
      resolve,
      started: undefined,
      settled: undefined,
    };
    payment.timer = timers.setTimeout(() => expire(payment), deadlineMs(challenge));
    // The timer must not keep a process alive that is otherwise done.
    (payment.timer as { unref?: () => void } | undefined)?.unref?.();
    open.set(id, payment);
  });

  const credentialCreated = observer('start a payment span', (payload, follow) => {
    const payment = paymentOf(payload);
    if (!payment) return;
    // A second credential for an open challenge starts no second span (ADR 0029).
    if (payment.started) return;
    follow(payment);
    const credential = own(payload, 'credential');
    // mppx creates text: a payment whose credential is none cannot be followed to its outcome.
    if (typeof credential !== 'string') {
      finish(payment, 'a payment without a credential');
      return;
    }
    const fields = credentialFieldsOf(credential);
    if (fields.type === 'proof') {
      finish(payment, 'a proof');
      return;
    }
    const handle = startSpan(payment, fields);
    if (!handle) {
      finish(payment, 'a payment without a chain');
      return;
    }
    const request = chargeRequestOf(payment.challenge);
    payment.started = {
      handle,
      credential,
      chainId: fields.chainId ?? (request.chainId as number),
      fields,
      request,
    };
  });

  const paymentResponse = observer('record a payment settlement', (payload, follow) => {
    const response = own(payload, 'response');
    // The copy of the paid response exists because this observer does: release it after the event's observers ran.
    timers.setTimeout(() => releaseCopy(response), 0);
    const payment = paymentOf(payload);
    const started = payment?.started;
    // A payment already settled and waiting for its receipt check takes no second outcome.
    if (
      !payment ||
      !started ||
      payment.settled ||
      own(payload, 'credential') !== started.credential
    ) {
      diag.debug('hashspan: a payment response for no open payment span; not recording it');
      return;
    }
    follow(payment);
    const endTime = new Date();
    const header = receiptHeaderOf(response);
    if (header === null || header === undefined) {
      finish(payment, 'payment without a settlement', (handle) =>
        handle.fail(undefined, { errorType: NO_SETTLEMENT, endTime }),
      );
      return;
    }
    const reported = reportedReceiptOf(header);
    if (!reported) {
      // A receipt that cannot be read still ends the payment span, as `_OTHER` (ADR 0025 rule 1).
      diag.debug('hashspan: could not read the Payment-Receipt header');
      finish(payment, 'unreadable settlement', (handle) => handle.fail(undefined, { endTime }));
      return;
    }
    const ownHash = started.fields.hash;
    // The payer's own hash wins; a server reporting another one did not settle this payment (ADR 0029).
    const hash = ownHash ?? reported.reference;
    const mismatch =
      ownHash !== undefined && reported.reference !== undefined && reported.reference !== ownHash;
    const settlement: PaymentSettlement = { status: 'settled', hash };
    const end = (verified?: boolean): void =>
      finish(payment, 'payment settlement', (handle) =>
        handle.end(verified === undefined ? settlement : { ...settlement, verified }, { endTime }),
      );
    if (hash === undefined) {
      end();
      return;
    }
    const confirmWith = readerFor(started.chainId);
    // The fee of an auto-swap or machine-token route is not paid by the payer's transfer: no verdict (ADR 0029).
    const funded =
      reported.fundingCurrency === undefined ||
      reported.fundingCurrency === addressOf(started.request.currency);
    // A hash the server named is checked against the nonce the payer signed; without one, there is no verdict.
    const signed = ownHash === undefined ? started.fields.signed : undefined;
    const checkable = ownHash !== undefined || signed !== undefined;
    const check =
      funded && !mismatch && checkable
        ? chargeCheckOf(payment.challenge, started.request, started.fields.payer)
        : undefined;
    if (ownHash === undefined) {
      try {
        started.handle.link(hash);
      } catch (error) {
        diag.error(`hashspan: failed to link the payment span (${errorName(error)})`);
      }
    }
    if (!confirmWith || !check) {
      end(mismatch ? false : undefined);
      if (confirmWith) {
        viem.watch(confirmWith, { hash, chainId: started.chainId, timeoutMs: confirmTimeoutMs });
      }
      return;
    }
    // The payment span ends once the receipt is checked, at the time the response came (ADR 0017).
    payment.settled = { settlement, endTime };
    timers.clearTimeout(payment.timer);
    viem.watch(confirmWith, {
      hash,
      chainId: started.chainId,
      timeoutMs: confirmTimeoutMs,
      onReceipt: (receipt) => {
        if (receipt === undefined) {
          end();
          return;
        }
        void verdictOf(confirmWith, check, signed, receipt)
          .then((verified) => end(verified))
          .catch((error: unknown) => {
            diag.error(`hashspan: failed to check the settlement (${errorName(error)})`);
            end();
          });
      },
    });
  });

  const paymentFailed = observer('record a payment failure', (payload, follow) => {
    // A failure for a challenge no observer saw (no method for it, an expired one) records nothing.
    const payment = paymentOf(payload);
    if (!payment || payment.settled) return;
    follow(payment);
    const error = own(payload, 'error');
    const endTime = new Date();
    const started = payment.started;
    if (!started) {
      // The credential was never created: the client's policy, a spending limit, signing or a failed push send.
      finish(
        payment,
        'payment failure',
        (handle) => handle.fail(error, { endTime }),
        startSpan(payment, NO_CREDENTIAL),
      );
      return;
    }
    const outcomeUnknown = own(error, 'name') === OUTCOME_UNKNOWN;
    const reportedHash = own(error, 'transactionHash');
    const hash =
      started.fields.hash ??
      (outcomeUnknown && typeof reportedHash === 'string' && TX_HASH.test(reportedHash)
        ? reportedHash.toLowerCase()
        : undefined);
    if (!outcomeUnknown || hash === undefined) {
      finish(payment, 'payment failure', (handle) => handle.fail(error, { endTime }));
      return;
    }
    // A 5xx, or a paid request that threw: the money may have moved. The confirm span resolves it.
    finish(payment, 'pending payment', (handle) =>
      handle.end({ status: 'pending', hash }, { endTime }),
    );
    const confirmWith = readerFor(started.chainId);
    if (confirmWith)
      viem.watch(confirmWith, { hash, chainId: started.chainId, timeoutMs: confirmTimeoutMs });
  });

  /** The open payments whose credential was created, so that a span waits for their outcome. */
  const paidPayments = (): Payment[] => [...open.values()].filter((payment) => payment.started);

  /**
   * Waits for every open payment with a span to end; true if they did before `deadline`, else ends them as `timeout`.
   * A challenge that got no credential has no span: flush does not wait for it, and its deadline still drops it.
   */
  const flushPayments = async (deadline: number): Promise<boolean> => {
    for (let paid = paidPayments(); paid.length > 0; paid = paidPayments()) {
      const remaining = deadline - Date.now();
      const settled =
        remaining > 0 &&
        (await new Promise<boolean>((resolve) => {
          const timer = timers.setTimeout(() => resolve(false), remaining);
          void Promise.all(paid.map((payment) => payment.done)).then(() => {
            timers.clearTimeout(timer);
            resolve(true);
          });
        }));
      if (!settled) {
        for (const payment of paidPayments()) timeOut(payment);
        return false;
      }
    }
    return true;
  };

  const handle: HashspanMpp = {
    flush: async (flushOptions) => {
      const deadline = Date.now() + flushTimeoutOf(flushOptions);
      try {
        // In order: an outcome that arrives while payments are awaited can start a confirmation for viem to await.
        const paymentsDone = await flushPayments(deadline);
        const viemDone = await viem.flush({ timeoutMs: Math.max(0, deadline - Date.now()) });
        return paymentsDone && viemDone;
      } catch (error) {
        diag.error(`hashspan: flush failed (${errorName(error)})`);
        return false;
      }
    },
  };
  const noop: HashspanMpp = { flush: (flushOptions) => viem.flush(flushOptions) };

  const target = client as Record<PropertyKey, unknown>;
  let existing: unknown;
  let on: unknown;
  try {
    existing = own(target, WRAPPED as unknown as string) ?? target[WRAPPED];
    on = target.on;
  } catch {
    // A client that cannot be read is not traced; withHashspan() never throws into the caller (ADR 0025 rule 1).
    diag.warn('hashspan: not tracing MPP payments: the client cannot be read');
    return noop;
  }
  if (isObject(existing)) {
    diag.warn(
      'hashspan: this mppx client is already traced; ignoring the options of the second withHashspan()',
    );
    return existing as HashspanMpp;
  }
  if (typeof on !== 'function') {
    diag.warn(
      'hashspan: not tracing MPP payments: pass the client Mppx.create() returns (with on(), mppx 0.6.21 or later)',
    );
    return noop;
  }
  if (!readsPayerSettlements(tracker)) {
    diag.warn(
      'hashspan: not tracing MPP payments: the tracker has no paymentSenders; use createTxTracker() from @hashspan/core 1.2 or later',
    );
    return noop;
  }
  try {
    Object.defineProperty(client, WRAPPED, { value: handle });
  } catch {
    diag.debug('hashspan: could not mark the mppx client as traced');
  }
  const observers = {
    'challenge.received': challengeReceived,
    'credential.created': credentialCreated,
    'payment.response': paymentResponse,
    'payment.failed': paymentFailed,
  } as const;
  for (const name of observeFailures === true ? EVENTS : DEFAULT_EVENTS) {
    try {
      Reflect.apply(on, client, [name, observers[name]]);
    } catch (error) {
      diag.error(`hashspan: failed to register the mppx observer of ${name} (${errorName(error)})`);
    }
  }
  return handle;
}
