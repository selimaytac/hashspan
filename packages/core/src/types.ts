import type {
  Attributes,
  Context,
  MeterProvider,
  TimeInput,
  TracerProvider,
} from '@opentelemetry/api';

/**
 * How wallet addresses are recorded: `raw` in lower case, `hashed` as a hash of the lower-cased address, `off` not at
 * all. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0004-privacy-defaults.md.
 */
export type AddressMode = 'raw' | 'hashed' | 'off';

/**
 * How error messages are recorded on exception events and span status. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0006-error-privacy.md.
 * - `off`: error type only
 * - `sanitized`: first line, addresses per address mode, other long hex data removed
 * - `raw`: full message and stack trace, as thrown
 */
export type ErrorMessageMode = 'off' | 'sanitized' | 'raw';

/**
 * How much of a paid resource's URL `x402.resource` records. Paths often carry user or account identifiers, so only
 * the origin is recorded by default (ADR 0004).
 * - `origin`: scheme, host and port only, e.g. `https://api.example.com`; a resource that is not a URL is not recorded
 * - `path`: the URL without its query string, fragment and user info
 * - `off`: nothing
 */
export type PaymentResourceMode = 'origin' | 'path' | 'off';

/** Address recording mode with options; see {@link TxTrackerOptions.address}. */
export interface AddressOptions {
  /** How addresses are recorded; `hash` applies to `hashed` mode only. */
  mode: AddressMode;
  /**
   * Custom hash for `hashed` mode; receives the lower-cased address.
   * Defaults to `sha256:` + the first 32 hex characters of SHA-256 (Node.js only).
   */
  hash?: ((address: string) => string) | undefined;
}

/**
 * Static agent identity, recorded on every span of the tracker. A field set here wins over the same Baggage entry;
 * see {@link TxTrackerOptions.agent}. Unlike Baggage, it is never propagated to other services.
 */
export interface AgentIdentity {
  /** Recorded as `gen_ai.agent.id`. */
  id?: string | undefined;
  /** Recorded as `gen_ai.agent.name`. */
  name?: string | undefined;
}

/** Options of `createTxTracker()`; the adapters' `withHashspan()` options extend them. */
export interface TxTrackerOptions {
  /** Defaults to the globally registered tracer provider. */
  tracerProvider?: TracerProvider | undefined;
  /**
   * Meter provider for the send, confirmation and fee histograms. Defaults to the globally registered one, which
   * records nothing until an OpenTelemetry metrics SDK is set up.
   */
  meterProvider?: MeterProvider | undefined;
  /** Address recording mode. Default: `raw`. */
  address?: AddressMode | AddressOptions | undefined;
  /**
   * Error message recording mode. Default: `off` (error type only). The redaction hook also runs on exception
   * attributes.
   */
  errorMessages?: ErrorMessageMode | undefined;
  /** How much of a paid resource's URL `x402.resource` records. Default: `origin`. */
  paymentResource?: PaymentResourceMode | undefined;
  /**
   * Record decoded contract call arguments ({@link SendInput.functionArguments}) as
   * `blockchain.contract.function.arguments`. Default: false. Arguments can carry amounts, counterparties and free
   * text; addresses in them follow the address mode and the redaction hook runs on them.
   */
  recordFunctionArguments?: boolean | undefined;
  /**
   * Agent identity. A field set here always wins; fields left unset are taken from the Baggage entries
   * `gen_ai.agent.id` / `gen_ai.agent.name` unless `agentFromBaggage` is false
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0011-agent-identity-precedence.md).
   */
  agent?: AgentIdentity | undefined;
  /**
   * Read agent identity fields that `agent` leaves unset from Baggage. Default: true. Baggage travels with requests
   * between services, so a remote caller can set it; services that accept requests from outside their trust boundary
   * should set this to false.
   */
  agentFromBaggage?: boolean | undefined;
  /**
   * Runs last on every attribute set, including exception event attributes, and returns the attributes to record.
   * If it throws or returns something other than an attributes object, the tracker fails closed and records only
   * `blockchain.system`, `blockchain.chain.id`, `blockchain.operation.name`, `blockchain.tx.hash`,
   * `blockchain.tx.status`, `blockchain.tx.replacement.hash`, `blockchain.tx.replacement.reason`,
   * `blockchain.payment.protocol`, `blockchain.payment.status`, `blockchain.payment.verified`,
   * `blockchain.user_operation.hash`, `blockchain.user_operation.success`, `error.type` and `exception.type`, and logs
   * the failure via `diag`.
   */
  redact?: ((attributes: Attributes) => Attributes) | undefined;
  /** How long a sent transaction or user operation can be linked from its confirmation. Default: 10 minutes. */
  linkTtlMs?: number | undefined;
  /**
   * Maximum number of sent transactions kept for linking. Default: 10 000. User operations are kept separately, up to
   * the same number.
   */
  maxTrackedTransactions?: number | undefined;
}

/** A transaction about to be sent, for {@link TxTracker.startSend}. */
export interface SendInput {
  /** EIP-155 chain id. */
  chainId: number;
  /** Sender address, recorded as `blockchain.tx.from` per the address mode. */
  from?: string | undefined;
  /** Recipient or contract address, recorded as `blockchain.tx.to` per the address mode. */
  to?: string | undefined;
  /** Value in wei. */
  value?: bigint | undefined;
  /** Sender nonce, when known before the send; omit it when the library or wallet fills it in. */
  nonce?: number | undefined;
  /** Name of the called contract function, when an ABI is known, e.g. `transfer`. */
  functionName?: string | undefined;
  /** 4-byte function selector, e.g. `0xa9059cbb`. */
  functionSelector?: string | undefined;
  /** Decoded call arguments; recorded only with the `recordFunctionArguments` tracker option. */
  functionArguments?: readonly unknown[] | undefined;
  /**
   * The EIP-7702 authorization list of a type 4 transaction. Its length is recorded as
   * `blockchain.tx.authorization.count`; for each well-formed entry (at most 64), its delegated address per the
   * address mode and its chain id. Signatures and nonces are never recorded.
   */
  authorizations?: readonly AuthorizationInput[] | undefined;
  /**
   * When the send started, for adapters that record it after the fact
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0009-telemetry-off-the-call-path.md).
   * Omit it otherwise: with an explicit start time, the SDK measures the span by the wall clock, so pass the end time
   * to the handle too.
   */
  startTime?: TimeInput | undefined;
}

/** One EIP-7702 authorization: the contract the account delegates to, and the chain it is valid on (0: every chain). */
export interface AuthorizationInput {
  /** The delegated contract address; `0x000...0` clears a delegation. */
  address: string;
  /** Chain id the authorization is valid on; 0 means every chain. */
  chainId: number;
}

/**
 * Ends a send span. Only the first call counts; methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface SendHandle {
  /**
   * The parent context with the send span set. Run the call that sends the transaction in it, e.g.
   * `await context.with(send.context, () => sendSomehow())`, so that spans of wallet, RPC or HTTP instrumentation
   * nest under the send span
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0015-send-span-as-active-context.md).
   * Run only that call in it: a confirm span started in it becomes a child of the send span.
   */
  readonly context: Context;
  /** Ends the send span successfully once the transaction hash is known. */
  end(result: SendResult, options?: EndOptions): void;
  /**
   * Ends the send span successfully with the transaction hash.
   *
   * @deprecated Use `end({ hash }, { endTime })`; removed in 1.0.
   */
  end(hash: string, endTime?: TimeInput): void;
  /** Ends the send span with an error (signing, simulation or broadcast failure). */
  fail(error: unknown, options?: FailOptions): void;
  /**
   * Ends the send span with an error.
   *
   * @deprecated Use `fail(error, { endTime, errorType })`; removed in 1.0.
   */
  fail(error: unknown, endTime: TimeInput | undefined, options?: FailOptions): void;
}

/** What a send produced. */
export interface SendResult {
  /** Hash of the sent transaction, `0x`-prefixed. */
  hash: string;
}

/** Options of every handle method. */
export interface EndOptions {
  /**
   * When the span ends, for adapters that record it after the fact; defaults to now. See
   * {@link SendInput.startTime}.
   */
  endTime?: TimeInput | undefined;
}

/** Options of the `fail` methods of handles. */
export interface FailOptions extends EndOptions {
  /**
   * `error.type` to record instead of the error's class name, for adapters whose library reports a stable,
   * machine-readable error code (for example a wallet API's error type). Recorded only if it matches
   * `/^[A-Za-z0-9_.-]{1,64}$/`, so that the attribute keeps a bounded set of values; otherwise the class name is
   * recorded. `exception.type` is always the class name.
   */
  errorType?: string | undefined;
}

/** A transaction whose receipt is awaited, for {@link TxTracker.startConfirm}. */
export interface ConfirmInput {
  /** EIP-155 chain id; with `hash`, it identifies the transaction and its confirm span. */
  chainId: number;
  /** Hash of the transaction awaited, `0x`-prefixed. */
  hash: string;
  /** When the wait started, for adapters that record it after the fact; see {@link SendInput.startTime}. */
  startTime?: TimeInput | undefined;
}

/** Why a transaction was replaced by another one with the same sender and nonce, as its library reported it. */
export type ReplacementReason = 'repriced' | 'cancelled' | 'replaced';

/** Library-agnostic view of a transaction receipt. Adapters normalise their client's receipt into this. */
export interface ReceiptLike {
  /** `reverted` ends the confirm span with an error status and `error.type` `reverted`. */
  status: 'success' | 'reverted';
  /** Block the transaction was included in. */
  blockNumber: bigint | number;
  /** Gas the transaction used. */
  gasUsed: bigint | number;
  /** Wei per gas actually paid. */
  effectiveGasPrice?: bigint | undefined;
  /** L1 data fee in wei on OP-stack chains. */
  l1Fee?: bigint | null | undefined;
  /**
   * Decoded revert reason, recorded as `blockchain.tx.revert.reason` with addresses per the address mode, e.g.
   * `Error(string)`'s message, `Panic(0x11)` or `InsufficientBalance(1, 2)`.
   */
  revertReason?: string | undefined;
  /**
   * Hash of the mined transaction. When it differs from the awaited hash, the awaited transaction was replaced: its
   * confirm span ends as `replaced` and the receipt is recorded for this hash
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0008-replaced-transactions.md).
   */
  transactionHash?: string | undefined;
  /** Replacement reason reported by the library, when `transactionHash` differs from the awaited hash. */
  replacementReason?: ReplacementReason | undefined;
}

/**
 * One wait for a transaction's receipt, joined to the transaction's shared confirm span. Only the first call counts;
 * methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface ConfirmHandle {
  /** Ends the shared confirm span with the receipt, for every handle of the transaction. */
  end(receipt: ReceiptLike, options?: EndOptions): void;
  /**
   * Ends the shared confirm span with the receipt.
   *
   * @deprecated Use `end(receipt, { endTime })`; removed in 1.0.
   */
  end(receipt: ReceiptLike, endTime?: TimeInput): void;
  /**
   * Withdraws this handle because waiting for the receipt timed out. The confirm span ends as `timeout` only if
   * no other handle of the transaction is still waiting.
   */
  timeout(options?: EndOptions): void;
  /**
   * Withdraws this handle because waiting for the receipt timed out.
   *
   * @deprecated Use `timeout({ endTime })`; removed in 1.0.
   */
  timeout(endTime?: TimeInput): void;
  /**
   * Withdraws this handle because retrieving the receipt failed. The confirm span ends as a failure only if no
   * other handle of the transaction is still waiting.
   */
  fail(error: unknown, options?: EndOptions): void;
  /**
   * Withdraws this handle because retrieving the receipt failed.
   *
   * @deprecated Use `fail(error, { endTime })`; removed in 1.0.
   */
  fail(error: unknown, endTime?: TimeInput): void;
}

/**
 * A payment the agent authorizes and another party settles on chain, e.g. an x402 facilitator
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0013-x402-payments.md).
 * Values often come from a remote server: addresses, amounts and identifiers that are malformed are not recorded.
 */
export interface PaymentInput {
  /** EIP-155 chain id of the network the payment settles on. */
  chainId: number;
  /** Payment protocol, e.g. `x402`; recorded only if it is a short identifier. */
  protocol: string;
  /** Address that pays, recorded per the address mode. */
  payer?: string | undefined;
  /** Address that is paid, recorded per the address mode. */
  recipient?: string | undefined;
  /** Contract address of the token paid with, recorded per the address mode. */
  asset?: string | undefined;
  /** Amount in the asset's smallest unit. */
  amount?: bigint | string | undefined;
  /** Fields of x402 payments. */
  x402?: X402PaymentDetails | undefined;
  /** When the payment started, for adapters that record it after the fact; see {@link SendInput.startTime}. */
  startTime?: TimeInput | undefined;
}

/** Fields of x402 payments, in {@link PaymentInput.x402}. */
export interface X402PaymentDetails {
  /** Payment scheme, e.g. `exact`; recorded only if it is a short identifier. */
  scheme?: string | undefined;
  /** URL or name of the resource paid for. Its query string, fragment and user info are never recorded. */
  resource?: string | undefined;
}

/** How a payment's settlement ended: `pending` means the transaction is known but its receipt was not seen. */
export type PaymentStatus = 'settled' | 'pending' | 'failed';

/** The settlement of a payment, as reported by the party that settled it. */
export interface PaymentSettlement {
  /** How the settlement ended, recorded as `blockchain.payment.status`. */
  status: PaymentStatus;
  /** Hash of the settling transaction; with it, a confirm span for this hash links to the payment span. */
  hash?: string | undefined;
  /** Address that paid, when the settlement reports it; recorded only when the payment's input had no payer. */
  payer?: string | undefined;
  /**
   * Amount settled, when the settlement reports it, recorded as `blockchain.payment.settled_amount`; also as
   * `blockchain.payment.amount` when the input had none.
   */
  amount?: bigint | string | undefined;
  /**
   * Whether the settlement transaction's receipt carries this payment, as the adapter checked it from the payer's own
   * data; recorded as `blockchain.payment.verified`. Leave it unset when no check was possible.
   */
  verified?: boolean | undefined;
  /** Why a `failed` settlement failed, recorded as `error.type` if it is a short identifier, else `_OTHER`. */
  errorReason?: string | undefined;
}

/**
 * Ends a payment span. Only the first call counts; methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface PaymentHandle {
  /** Ends the payment span with its settlement. */
  end(settlement: PaymentSettlement, options?: EndOptions): void;
  /**
   * Ends the payment span with an error when the payment could not be made, e.g. signing it failed. Called without
   * an error, as `fail(undefined, { errorType })`, it records no exception event: for outcomes that are not
   * exceptions, such as a response without a settlement (`no_settlement`).
   */
  fail(error: unknown, options?: FailOptions): void;
  /**
   * Ends the payment span with `error.type` `timeout` and no `blockchain.payment.status`, when its outcome was never
   * learned, e.g. no response arrived before the authorization expired.
   */
  timeout(options?: EndOptions): void;
  /**
   * Makes the confirm span of the settling transaction `hash` link to this payment span before it ends, for an
   * adapter that ends it only after checking that transaction's receipt (ADR 0017). A hash this tracker already links,
   * such as one of its own sends, keeps its link; `end` with a hash links it as well.
   */
  link(hash: string): void;
}

/**
 * A user operation of an ERC-4337 smart account, handed to a bundler
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0021-user-operations.md). It has no
 * transaction of its own: the bundler includes it in a bundle transaction that the bundler sends.
 */
export interface UserOperationInput {
  /** EIP-155 chain id. */
  chainId: number;
  /** Address of the smart account, recorded as `blockchain.user_operation.sender` per the address mode. */
  sender?: string | undefined;
  /** Address of the EntryPoint contract, recorded as `blockchain.user_operation.entry_point` per the address mode. */
  entryPoint?: string | undefined;
  /** Number of calls the operation makes, recorded as `blockchain.user_operation.call_count`. */
  callCount?: number | undefined;
  /** When the send started, for adapters that record it after the fact; see {@link SendInput.startTime}. */
  startTime?: TimeInput | undefined;
}

/** What handing a user operation to a bundler produced. */
export interface UserOperationResult {
  /** Hash of the user operation, `0x`-prefixed 32 bytes, as the bundler returned it. */
  userOpHash: string;
}

/**
 * Ends the send span of a user operation. Only the first call counts; methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface UserOperationSendHandle {
  /**
   * The parent context with the send span set. Run the call that hands the operation to the bundler in it, as for
   * {@link SendHandle.context}.
   */
  readonly context: Context;
  /** Ends the send span successfully once the user operation hash is known. */
  end(result: UserOperationResult, options?: EndOptions): void;
  /** Ends the send span with an error (preparing, signing or handing the operation to the bundler failed). */
  fail(error: unknown, options?: FailOptions): void;
}

/** A user operation whose receipt is awaited, for {@link TxTracker.startUserOperationConfirm}. */
export interface UserOperationConfirmInput {
  /** EIP-155 chain id; with `userOpHash`, it identifies the user operation and its confirm span. */
  chainId: number;
  /** Hash of the user operation awaited, `0x`-prefixed. */
  userOpHash: string;
  /** When the wait started, for adapters that record it after the fact; see {@link SendInput.startTime}. */
  startTime?: TimeInput | undefined;
}

/**
 * Library-agnostic view of a user operation receipt (ERC-4337 `eth_getUserOperationReceipt`, or the EntryPoint's
 * `UserOperationEvent`). Every field is optional, since some SDKs report less; values usually come from a bundler,
 * and malformed ones are not recorded.
 */
export interface UserOperationReceiptLike {
  /**
   * Whether the operation's calls succeeded. `false` ends the confirm span with an error status and `error.type`
   * `reverted`; the bundle transaction itself can still have succeeded.
   */
  success?: boolean | undefined;
  /** What the operation paid, in wei (`actualGasCost`), recorded as `blockchain.user_operation.gas.cost`. */
  actualGasCost?: bigint | string | undefined;
  /** Gas the operation used (`actualGasUsed`), recorded as `blockchain.user_operation.gas.used`. */
  actualGasUsed?: bigint | number | string | undefined;
  /** Address of the smart account. */
  sender?: string | undefined;
  /**
   * The operation's nonce, recorded as a decimal string: it holds a 192-bit key and a 64-bit sequence number. Bundlers
   * return it as a hex string, which some libraries pass on unchanged.
   */
  nonce?: bigint | string | undefined;
  /** Address of the paymaster that paid for the operation; the zero address means none. */
  paymaster?: string | undefined;
  /** Address of the EntryPoint contract. */
  entryPoint?: string | undefined;
  /** Decoded revert reason, recorded as `blockchain.tx.revert.reason` with addresses per the address mode. */
  revertReason?: string | undefined;
  /** Hash of the bundle transaction that included the operation, recorded as `blockchain.tx.hash`. */
  transactionHash?: string | undefined;
  /** Block of the bundle transaction. */
  blockNumber?: bigint | number | undefined;
}

/**
 * One wait for a user operation's receipt, joined to the operation's shared confirm span, as for transactions
 * ({@link ConfirmHandle}). Only the first call counts; methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface UserOperationConfirmHandle {
  /** Ends the shared confirm span with the receipt, for every handle of the user operation. */
  end(receipt: UserOperationReceiptLike, options?: EndOptions): void;
  /**
   * Withdraws this handle because waiting for the receipt timed out. The confirm span ends as `timeout` only if no
   * other handle of the user operation is still waiting.
   */
  timeout(options?: EndOptions): void;
  /**
   * Withdraws this handle because the operation failed or its receipt could not be retrieved. The confirm span ends
   * as a failure only if no other handle is still waiting. Called without an error, as
   * `fail(undefined, { errorType })`, it records no exception event: for an SDK that reports a failed operation
   * without an error.
   */
  fail(error: unknown, options?: FailOptions): void;
}

/**
 * A batch of calls handed to a wallet with EIP-5792 `wallet_sendCalls`
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0022-call-batches.md). The wallet decides
 * how the calls reach the chain: in one transaction, several, or a user operation.
 */
export interface CallBatchInput {
  /** EIP-155 chain id. */
  chainId: number;
  /** Address of the account the calls are sent from, recorded as `blockchain.call_batch.sender` per the address mode. */
  sender?: string | undefined;
  /** Number of calls in the batch, recorded as `blockchain.call_batch.call_count`. */
  callCount?: number | undefined;
  /** When the send started, for adapters that record it after the fact; see {@link SendInput.startTime}. */
  startTime?: TimeInput | undefined;
}

/** What handing a call batch to a wallet produced. */
export interface CallBatchResult {
  /**
   * The batch id the wallet returned, which identifies the batch with the chain id: `0x`-prefixed hex of at most 8194
   * characters. Any other id is not recorded.
   */
  id: string;
  /**
   * Hashes of transactions the account itself sent for the batch, when the adapter knows them (viem's fallback to
   * `eth_sendTransaction`). Each is recorded as sent by the batch's send span, so its confirm span links to it.
   */
  transactionHashes?: readonly string[] | undefined;
}

/**
 * Ends the send span of a call batch. Only the first call counts; methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface CallBatchSendHandle {
  /**
   * The parent context with the send span set. Run the call that hands the batch to the wallet in it, as for
   * {@link SendHandle.context}.
   */
  readonly context: Context;
  /** Ends the send span successfully once the batch id is known. */
  end(result: CallBatchResult, options?: EndOptions): void;
  /** Ends the send span with an error (the wallet rejected the batch, or sending it failed). */
  fail(error: unknown, options?: FailOptions): void;
}

/** A call batch whose status is awaited, for {@link TxTracker.startCallBatchConfirm}. */
export interface CallBatchConfirmInput {
  /** EIP-155 chain id; with `id`, it identifies the batch and its confirm span. */
  chainId: number;
  /** The batch id awaited, as the wallet returned it. */
  id: string;
  /** When the wait started, for adapters that record it after the fact; see {@link SendInput.startTime}. */
  startTime?: TimeInput | undefined;
}

/**
 * Library-agnostic view of an EIP-5792 call batch status (`wallet_getCallsStatus`). Every field is optional; values
 * come from a wallet, and malformed ones are not recorded.
 */
export interface CallBatchStatusLike {
  /**
   * The EIP-5792 status code, recorded as `blockchain.call_batch.status_code`. 200 ends the confirm span as
   * `success`, 500 as `reverted` and 600 as `partially_reverted` (`blockchain.call_batch.status`); 400 (failed without
   * inclusion) with `error.type` `failed`; 100 (still pending) without an outcome; any other code, or none, with
   * `error.type` `_OTHER`.
   */
  statusCode?: number | undefined;
  /** Whether the wallet ran the calls atomically. */
  atomic?: boolean | undefined;
  /**
   * Receipts of the transactions that carried the batch; only their hashes (validated, de-duplicated, at most 64) and
   * the highest block number are recorded.
   */
  receipts?:
    | readonly {
        transactionHash?: string | undefined;
        blockNumber?: bigint | number | undefined;
      }[]
    | undefined;
}

/**
 * One wait for a call batch's status, joined to the batch's shared confirm span, as for transactions
 * ({@link ConfirmHandle}). Only the first call counts; methods never throw.
 * Produced by the tracker only; methods may be added in minor releases
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0014-core-api-boundary.md).
 */
export interface CallBatchConfirmHandle {
  /** Ends the shared confirm span with the status, for every handle of the batch. */
  end(status: CallBatchStatusLike, options?: EndOptions): void;
  /**
   * Withdraws this handle because waiting for the status timed out. The confirm span ends as `timeout` only if no
   * other handle of the batch is still waiting.
   */
  timeout(options?: EndOptions): void;
  /**
   * Withdraws this handle because the status could not be retrieved. The confirm span ends as a failure only if no
   * other handle is still waiting.
   */
  fail(error: unknown, options?: FailOptions): void;
}
