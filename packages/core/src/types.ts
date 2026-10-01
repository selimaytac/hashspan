import type { Attributes, TimeInput, TracerProvider } from '@opentelemetry/api';

/** How wallet addresses are recorded. See docs/adr/0004-privacy-defaults.md. */
export type AddressMode = 'raw' | 'hashed' | 'off';

/**
 * How error messages are recorded on exception events and span status. See docs/adr/0006-error-privacy.md.
 * - `off`: error type only
 * - `sanitized`: first line, addresses per address mode, other long hex data removed
 * - `raw`: full message and stack trace, as thrown
 */
export type ErrorMessageMode = 'off' | 'sanitized' | 'raw';

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

export interface TxTrackerOptions {
  /** Defaults to the globally registered tracer provider. */
  tracerProvider?: TracerProvider | undefined;
  /** Address recording mode. Default: `raw`. */
  address?: AddressMode | AddressOptions | undefined;
  /**
   * Error message recording mode. Default: `off` (error type only). The redaction hook also runs on exception
   * attributes.
   */
  errorMessages?: ErrorMessageMode | undefined;
  /**
   * Record decoded contract call arguments ({@link SendInput.functionArguments}) as
   * `blockchain.contract.function.arguments`. Default: false. Arguments can carry amounts, counterparties and free
   * text; addresses in them follow the address mode and the redaction hook runs on them.
   */
  recordFunctionArguments?: boolean | undefined;
  /**
   * Agent identity. A field set here always wins; fields left unset are taken from the Baggage entries
   * `gen_ai.agent.id` / `gen_ai.agent.name` unless `agentFromBaggage` is false (docs/adr/0011).
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
   * `blockchain.tx.status`, `blockchain.tx.replacement.hash`, `blockchain.tx.replacement.reason`, `error.type` and
   * `exception.type`, and logs the failure via `diag`.
   */
  redact?: ((attributes: Attributes) => Attributes) | undefined;
  /** How long a sent transaction can be linked from its confirmation. Default: 10 minutes. */
  linkTtlMs?: number | undefined;
  /** Maximum number of sent transactions kept for linking. Default: 10 000. */
  maxTrackedTransactions?: number | undefined;
}

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
   * When the send started, for adapters that record it after the fact (docs/adr/0009). Omit it otherwise: with an
   * explicit start time, the SDK measures the span by the wall clock, so pass the end time to the handle too.
   */
  startTime?: TimeInput | undefined;
}

/** Ends a send span. Only the first call counts; methods never throw. */
export interface SendHandle {
  /** Ends the send span successfully once the transaction hash is known; `endTime` defaults to now. */
  end(hash: string, endTime?: TimeInput): void;
  /** Ends the send span with an error (signing, simulation or broadcast failure); `endTime` defaults to now. */
  fail(error: unknown, endTime?: TimeInput, options?: FailOptions): void;
}

export interface FailOptions {
  /**
   * `error.type` to record instead of the error's class name, for adapters whose library reports a stable,
   * machine-readable error code (for example a wallet API's error type). Recorded only if it matches
   * `/^[A-Za-z0-9_.-]{1,64}$/`, so that the attribute keeps a bounded set of values; otherwise the class name is
   * recorded. `exception.type` is always the class name.
   */
  errorType?: string | undefined;
}

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
  blockNumber: bigint | number;
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
   * Hash of the mined transaction. When it differs from the awaited hash, the awaited transaction was replaced:
   * its confirm span ends as `replaced` and the receipt is recorded for this hash (docs/adr/0008).
   */
  transactionHash?: string | undefined;
  /** Replacement reason reported by the library, when {@link transactionHash} differs from the awaited hash. */
  replacementReason?: ReplacementReason | undefined;
}

/**
 * One wait for a transaction's receipt, joined to the transaction's shared confirm span. Only the first call counts;
 * methods never throw.
 */
export interface ConfirmHandle {
  /** Ends the shared confirm span with the receipt, for every handle of the transaction. */
  end(receipt: ReceiptLike, endTime?: TimeInput): void;
  /**
   * Withdraws this handle because waiting for the receipt timed out. The confirm span ends as `timeout` only if
   * no other handle of the transaction is still waiting.
   */
  timeout(endTime?: TimeInput): void;
  /**
   * Withdraws this handle because retrieving the receipt failed. The confirm span ends as a failure only if no
   * other handle of the transaction is still waiting.
   */
  fail(error: unknown, endTime?: TimeInput): void;
}
