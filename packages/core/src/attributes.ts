/**
 * Attribute keys emitted by hashspan.
 *
 * Stability: development. See https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.5.0/docs/semconv.md for
 * definitions and value types. These names are a public contract: changes follow the deprecation policy in AGENTS.md.
 */
export const ATTR_BLOCKCHAIN_SYSTEM = 'blockchain.system' as const;
export const ATTR_BLOCKCHAIN_CHAIN_ID = 'blockchain.chain.id' as const;
export const ATTR_BLOCKCHAIN_OPERATION_NAME = 'blockchain.operation.name' as const;
export const ATTR_BLOCKCHAIN_TX_HASH = 'blockchain.tx.hash' as const;
export const ATTR_BLOCKCHAIN_TX_FROM = 'blockchain.tx.from' as const;
export const ATTR_BLOCKCHAIN_TX_TO = 'blockchain.tx.to' as const;
export const ATTR_BLOCKCHAIN_TX_VALUE = 'blockchain.tx.value' as const;
export const ATTR_BLOCKCHAIN_TX_NONCE = 'blockchain.tx.nonce' as const;
export const ATTR_BLOCKCHAIN_TX_STATUS = 'blockchain.tx.status' as const;
export const ATTR_BLOCKCHAIN_TX_GAS_USED = 'blockchain.tx.gas.used' as const;
export const ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE = 'blockchain.tx.effective_gas_price' as const;
export const ATTR_BLOCKCHAIN_TX_L1_FEE = 'blockchain.tx.l1_fee' as const;
export const ATTR_BLOCKCHAIN_TX_FEE = 'blockchain.tx.fee' as const;
export const ATTR_BLOCKCHAIN_TX_REVERT_REASON = 'blockchain.tx.revert.reason' as const;
export const ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH = 'blockchain.tx.replacement.hash' as const;
export const ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON = 'blockchain.tx.replacement.reason' as const;
export const ATTR_BLOCKCHAIN_BLOCK_NUMBER = 'blockchain.block.number' as const;
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME = 'blockchain.contract.function.name' as const;
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR =
  'blockchain.contract.function.selector' as const;
/**
 * Opt-in: decoded call arguments as a JSON array. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.5.0/docs/adr/0004-privacy-defaults.md.
 */
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS =
  'blockchain.contract.function.arguments' as const;

/**
 * Payments settled on chain by a party other than the agent, e.g. an x402 facilitator. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.5.0/docs/adr/0013-x402-payments.md.
 */
export const ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL = 'blockchain.payment.protocol' as const;
export const ATTR_BLOCKCHAIN_PAYMENT_PAYER = 'blockchain.payment.payer' as const;
export const ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT = 'blockchain.payment.recipient' as const;
export const ATTR_BLOCKCHAIN_PAYMENT_ASSET = 'blockchain.payment.asset' as const;
export const ATTR_BLOCKCHAIN_PAYMENT_AMOUNT = 'blockchain.payment.amount' as const;
export const ATTR_BLOCKCHAIN_PAYMENT_STATUS = 'blockchain.payment.status' as const;
/** The amount the settling party reports it settled, e.g. less than the authorized maximum with x402 `upto`. */
export const ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT = 'blockchain.payment.settled_amount' as const;
/**
 * Whether the settlement transaction's receipt carries the payment, as checked by the adapter; absent when no check
 * was possible. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.5.0/docs/adr/0017-x402-payment-verification.md.
 */
export const ATTR_BLOCKCHAIN_PAYMENT_VERIFIED = 'blockchain.payment.verified' as const;
/** x402's own payment fields. */
export const ATTR_X402_SCHEME = 'x402.scheme' as const;
export const ATTR_X402_RESOURCE = 'x402.resource' as const;

/** Values for {@link ATTR_BLOCKCHAIN_SYSTEM}. */
export const BLOCKCHAIN_SYSTEM_VALUE_EVM = 'evm' as const;

/** Values for {@link ATTR_BLOCKCHAIN_OPERATION_NAME}. */
export const BLOCKCHAIN_OPERATION_NAME_VALUE_SEND = 'send' as const;
export const BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM = 'confirm' as const;
export const BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT = 'payment' as const;

/** Values for {@link ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL}. */
export const BLOCKCHAIN_PAYMENT_PROTOCOL_VALUE_X402 = 'x402' as const;

/** Values for {@link ATTR_BLOCKCHAIN_PAYMENT_STATUS}. */
export const BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED = 'settled' as const;
export const BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING = 'pending' as const;
export const BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED = 'failed' as const;

/** Values for {@link ATTR_BLOCKCHAIN_TX_STATUS}. */
export const BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS = 'success' as const;
export const BLOCKCHAIN_TX_STATUS_VALUE_REVERTED = 'reverted' as const;
/**
 * @deprecated No longer recorded: a confirm span that gave up waiting records `error.type` `timeout` and no
 * `blockchain.tx.status`. The constant is removed in 1.0. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.5.0/docs/adr/0016-timeout-is-an-observer-outcome.md.
 */
export const BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT = 'timeout' as const;
export const BLOCKCHAIN_TX_STATUS_VALUE_REPLACED = 'replaced' as const;

/** Values for {@link ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON}, as reported by the instrumented library. */
export const BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPRICED = 'repriced' as const;
export const BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_CANCELLED = 'cancelled' as const;
export const BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPLACED = 'replaced' as const;

/** Reused from OpenTelemetry general conventions. */
export const ATTR_ERROR_TYPE = 'error.type' as const;
/** Fallback {@link ATTR_ERROR_TYPE} value when the error has no name. */
export const ERROR_TYPE_VALUE_OTHER = '_OTHER' as const;
