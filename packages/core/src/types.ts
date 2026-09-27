import type { Attributes, TracerProvider } from '@opentelemetry/api';

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
  mode: AddressMode;
  /**
   * Custom hash for `hashed` mode; receives the lower-cased address.
   * Defaults to `sha256:` + the first 32 hex characters of SHA-256 (Node.js only).
   */
  hash?: ((address: string) => string) | undefined;
}

/** Static agent identity, used when the active context carries none in its baggage. */
export interface AgentIdentity {
  id?: string | undefined;
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
  /** Fallback agent identity. Baggage entries `gen_ai.agent.id` / `gen_ai.agent.name` take precedence. */
  agent?: AgentIdentity | undefined;
  /**
   * Runs last on every attribute set and returns the attributes to record.
   * If it throws, only non-sensitive identifiers (system, chain id, operation, hash) are recorded.
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
  from?: string | undefined;
  to?: string | undefined;
  /** Value in wei. */
  value?: bigint | undefined;
  nonce?: number | undefined;
  functionName?: string | undefined;
  /** 4-byte function selector, e.g. `0xa9059cbb`. */
  functionSelector?: string | undefined;
}

export interface SendHandle {
  /** Ends the send span successfully once the transaction hash is known. */
  end(hash: string): void;
  /** Ends the send span with an error (signing, simulation or broadcast failure). */
  fail(error: unknown): void;
}

export interface ConfirmInput {
  chainId: number;
  hash: string;
}

/** Library-agnostic view of a transaction receipt. Adapters normalise their client's receipt into this. */
export interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint | number;
  gasUsed: bigint | number;
  /** Wei per gas actually paid. */
  effectiveGasPrice?: bigint | undefined;
  /** L1 data fee in wei on OP-stack chains. */
  l1Fee?: bigint | null | undefined;
  revertReason?: string | undefined;
}

export interface ConfirmHandle {
  /** Ends the shared confirm span with the receipt, for every handle of the transaction. */
  end(receipt: ReceiptLike): void;
  /**
   * Withdraws this handle because waiting for the receipt timed out. The confirm span ends as `timeout` only if
   * no other handle of the transaction is still waiting.
   */
  timeout(): void;
  /**
   * Withdraws this handle because retrieving the receipt failed. The confirm span ends as a failure only if no
   * other handle of the transaction is still waiting.
   */
  fail(error: unknown): void;
}
