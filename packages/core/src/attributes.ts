/**
 * Attribute keys emitted by hashspan.
 *
 * Stability: development. See https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/semconv.md for
 * definitions and value types. These names are a public contract: changes follow the deprecation policy in AGENTS.md.
 */
/**
 * The kind of chain: `evm`.
 *
 * @deprecated Renamed to `blockchain.system.name` ({@link ATTR_BLOCKCHAIN_SYSTEM_NAME}). Both are recorded with the
 * same value until 1.0, which removes this attribute and the constant.
 */
export const ATTR_BLOCKCHAIN_SYSTEM = 'blockchain.system' as const;
/** The kind of chain, `evm`; on every span except JSON-RPC spans, and on every metric sample. */
export const ATTR_BLOCKCHAIN_SYSTEM_NAME = 'blockchain.system.name' as const;
/** EIP-155 chain id, e.g. `8453`; on every span. */
export const ATTR_BLOCKCHAIN_CHAIN_ID = 'blockchain.chain.id' as const;
/** The operation a span records: `send`, `confirm` or `payment`. */
export const ATTR_BLOCKCHAIN_OPERATION_NAME = 'blockchain.operation.name' as const;
/** `0x`-prefixed transaction hash; on a payment span, the settling transaction's, when reported. */
export const ATTR_BLOCKCHAIN_TX_HASH = 'blockchain.tx.hash' as const;
/** Sender address of a send span, per the address mode. */
export const ATTR_BLOCKCHAIN_TX_FROM = 'blockchain.tx.from' as const;
/** Recipient or contract address of a send span, per the address mode. */
export const ATTR_BLOCKCHAIN_TX_TO = 'blockchain.tx.to' as const;
/** Value sent, in wei, as a decimal string. */
export const ATTR_BLOCKCHAIN_TX_VALUE = 'blockchain.tx.value' as const;
/** Sender nonce, when the sending call passes one. */
export const ATTR_BLOCKCHAIN_TX_NONCE = 'blockchain.tx.nonce' as const;
/** Number of EIP-7702 authorizations a type 4 transaction carries. */
export const ATTR_BLOCKCHAIN_TX_AUTHORIZATION_COUNT = 'blockchain.tx.authorization.count' as const;
/** Delegated contract address of each well-formed EIP-7702 authorization, per the address mode; at most 64. */
export const ATTR_BLOCKCHAIN_TX_AUTHORIZATION_ADDRESSES =
  'blockchain.tx.authorization.addresses' as const;
/** Chain id of each well-formed EIP-7702 authorization, aligned with the addresses; 0 means every chain. */
export const ATTR_BLOCKCHAIN_TX_AUTHORIZATION_CHAIN_IDS =
  'blockchain.tx.authorization.chain_ids' as const;
/** Outcome of a confirmed transaction from chain data: `success`, `reverted` or `replaced`. */
export const ATTR_BLOCKCHAIN_TX_STATUS = 'blockchain.tx.status' as const;
/** Gas the transaction used. */
export const ATTR_BLOCKCHAIN_TX_GAS_USED = 'blockchain.tx.gas.used' as const;
/** Wei per gas the transaction paid, as a decimal string. */
export const ATTR_BLOCKCHAIN_TX_EFFECTIVE_GAS_PRICE = 'blockchain.tx.effective_gas_price' as const;
/** L1 data fee on OP-stack chains, in wei, as a decimal string. */
export const ATTR_BLOCKCHAIN_TX_L1_FEE = 'blockchain.tx.l1_fee' as const;
/** Fee of the transaction, in wei: gas used times the effective gas price, plus the L1 fee. */
export const ATTR_BLOCKCHAIN_TX_FEE = 'blockchain.tx.fee' as const;
/** Decoded revert reason of a reverted transaction or user operation, when available. */
export const ATTR_BLOCKCHAIN_TX_REVERT_REASON = 'blockchain.tx.revert.reason' as const;
/** On a `replaced` confirm span: hash of the mined transaction that replaced it. */
export const ATTR_BLOCKCHAIN_TX_REPLACEMENT_HASH = 'blockchain.tx.replacement.hash' as const;
/** On a `replaced` confirm span: why the transaction was replaced, as the library reported it. */
export const ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON = 'blockchain.tx.replacement.reason' as const;
/** Block the transaction was included in. */
export const ATTR_BLOCKCHAIN_BLOCK_NUMBER = 'blockchain.block.number' as const;
/** Name of the called contract function, when an ABI is known. */
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME = 'blockchain.contract.function.name' as const;
/** 4-byte function selector, e.g. `0xa9059cbb`. */
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR =
  'blockchain.contract.function.selector' as const;
/**
 * Opt-in: decoded call arguments as a JSON array. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0004-privacy-defaults.md.
 */
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_ARGUMENTS =
  'blockchain.contract.function.arguments' as const;

/**
 * Payments settled on chain by a party other than the agent, e.g. an x402 facilitator. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0013-x402-payments.md.
 */
export const ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL = 'blockchain.payment.protocol' as const;
/** Address that pays, per the address mode. */
export const ATTR_BLOCKCHAIN_PAYMENT_PAYER = 'blockchain.payment.payer' as const;
/** Address that is paid, per the address mode. */
export const ATTR_BLOCKCHAIN_PAYMENT_RECIPIENT = 'blockchain.payment.recipient' as const;
/** Contract address of the token paid with, per the address mode. */
export const ATTR_BLOCKCHAIN_PAYMENT_ASSET = 'blockchain.payment.asset' as const;
/** Amount paid, in the asset's smallest unit, as a decimal string. */
export const ATTR_BLOCKCHAIN_PAYMENT_AMOUNT = 'blockchain.payment.amount' as const;
/** How the settlement of a payment ended: `settled`, `pending` or `failed`. */
export const ATTR_BLOCKCHAIN_PAYMENT_STATUS = 'blockchain.payment.status' as const;
/** The amount the settling party reports it settled, e.g. less than the authorized maximum with x402 `upto`. */
export const ATTR_BLOCKCHAIN_PAYMENT_SETTLED_AMOUNT = 'blockchain.payment.settled_amount' as const;
/**
 * Whether the settlement transaction's receipt carries the payment, as checked by the adapter; absent when no check
 * was possible. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0017-x402-payment-verification.md.
 */
export const ATTR_BLOCKCHAIN_PAYMENT_VERIFIED = 'blockchain.payment.verified' as const;
/** x402's own payment fields. */
export const ATTR_X402_SCHEME = 'x402.scheme' as const;
/** The resource paid for, as much of its URL as the tracker's `paymentResource` mode records. */
export const ATTR_X402_RESOURCE = 'x402.resource' as const;

/**
 * User operations of ERC-4337 smart accounts. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0021-user-operations.md.
 */
export const ATTR_BLOCKCHAIN_USER_OPERATION_HASH = 'blockchain.user_operation.hash' as const;
/** Address of the smart account, per the address mode. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_SENDER = 'blockchain.user_operation.sender' as const;
/** Address of the EntryPoint contract, per the address mode. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_ENTRY_POINT =
  'blockchain.user_operation.entry_point' as const;
/** Number of calls the user operation makes, when the adapter knows them. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_CALL_COUNT =
  'blockchain.user_operation.call_count' as const;
/** Nonce of the user operation, as a decimal string. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_NONCE = 'blockchain.user_operation.nonce' as const;
/** Whether the user operation's calls succeeded. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_SUCCESS = 'blockchain.user_operation.success' as const;
/** Gas the user operation used (`actualGasUsed`). */
export const ATTR_BLOCKCHAIN_USER_OPERATION_GAS_USED =
  'blockchain.user_operation.gas.used' as const;
/** What the operation itself paid, in wei; the bundle transaction's fee covers every operation in the bundle. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_GAS_COST =
  'blockchain.user_operation.gas.cost' as const;
/** Address of the paymaster that paid for the user operation, per the address mode. */
export const ATTR_BLOCKCHAIN_USER_OPERATION_PAYMASTER =
  'blockchain.user_operation.paymaster' as const;
// Call batches of EIP-5792 `sendCalls` (docs/adr/0022-call-batches.md).
/**
 * The batch id the wallet returned, truncated after 256 characters. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0022-call-batches.md.
 */
export const ATTR_BLOCKCHAIN_CALL_BATCH_ID = 'blockchain.call_batch.id' as const;
/** Address of the account the calls of a batch are sent from, per the address mode. */
export const ATTR_BLOCKCHAIN_CALL_BATCH_SENDER = 'blockchain.call_batch.sender' as const;
/** Number of calls in the batch. */
export const ATTR_BLOCKCHAIN_CALL_BATCH_CALL_COUNT = 'blockchain.call_batch.call_count' as const;
/** The outcome of a batch from chain data: `success`, `reverted` or `partially_reverted`. */
export const ATTR_BLOCKCHAIN_CALL_BATCH_STATUS = 'blockchain.call_batch.status' as const;
/** The EIP-5792 status code of the batch as the wallet reported it, e.g. 200 confirmed or 500 reverted; spans only. */
export const ATTR_BLOCKCHAIN_CALL_BATCH_STATUS_CODE = 'blockchain.call_batch.status_code' as const;
/** Whether the wallet ran the calls of the batch atomically. */
export const ATTR_BLOCKCHAIN_CALL_BATCH_ATOMIC = 'blockchain.call_batch.atomic' as const;
/** Hashes of the transactions whose receipts the wallet reported for the batch. */
export const ATTR_BLOCKCHAIN_CALL_BATCH_TRANSACTION_HASHES =
  'blockchain.call_batch.transaction_hashes' as const;
/**
 * Metrics only: what a send, confirmation or fee sample is about. Recorded as `user_operation` on samples of user
 * operations and `call_batch` on those of call batches, and absent on those of transactions.
 */
export const ATTR_BLOCKCHAIN_OPERATION_SUBJECT = 'blockchain.operation.subject' as const;

/** Values for {@link ATTR_BLOCKCHAIN_OPERATION_SUBJECT}. */
export const BLOCKCHAIN_OPERATION_SUBJECT_VALUE_USER_OPERATION = 'user_operation' as const;
/** Metric samples of a call batch. */
export const BLOCKCHAIN_OPERATION_SUBJECT_VALUE_CALL_BATCH = 'call_batch' as const;
/**
 * Metrics only: who paid a fee sample's fee when it was not the sender of the traced transaction or operation:
 * `facilitator` for the settlement transaction of a payment, `paymaster` for a user operation a paymaster paid for.
 * Absent when the sender paid.
 */
export const ATTR_BLOCKCHAIN_FEE_PAYER = 'blockchain.fee.payer' as const;

/** Values for {@link ATTR_BLOCKCHAIN_FEE_PAYER}. */
export const BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR = 'facilitator' as const;
/** A paymaster paid for the user operation. */
export const BLOCKCHAIN_FEE_PAYER_VALUE_PAYMASTER = 'paymaster' as const;

/** Values for {@link ATTR_BLOCKCHAIN_CALL_BATCH_STATUS}. */
export const BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_SUCCESS = 'success' as const;
/** The batch reverted. */
export const BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_REVERTED = 'reverted' as const;
/** Some of the calls of the batch reverted. */
export const BLOCKCHAIN_CALL_BATCH_STATUS_VALUE_PARTIALLY_REVERTED = 'partially_reverted' as const;

/** Values for {@link ATTR_BLOCKCHAIN_SYSTEM_NAME} and the deprecated {@link ATTR_BLOCKCHAIN_SYSTEM}. */
export const BLOCKCHAIN_SYSTEM_VALUE_EVM = 'evm' as const;

/** Values for {@link ATTR_BLOCKCHAIN_OPERATION_NAME}. */
export const BLOCKCHAIN_OPERATION_NAME_VALUE_SEND = 'send' as const;
/** A confirm span: the wait for a receipt. */
export const BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM = 'confirm' as const;
/** A payment span: a payment another party settles. */
export const BLOCKCHAIN_OPERATION_NAME_VALUE_PAYMENT = 'payment' as const;

/** Values for {@link ATTR_BLOCKCHAIN_PAYMENT_PROTOCOL}. */
export const BLOCKCHAIN_PAYMENT_PROTOCOL_VALUE_X402 = 'x402' as const;

/** Values for {@link ATTR_BLOCKCHAIN_PAYMENT_STATUS}. */
export const BLOCKCHAIN_PAYMENT_STATUS_VALUE_SETTLED = 'settled' as const;
/** The settling transaction is known, its receipt was not seen. */
export const BLOCKCHAIN_PAYMENT_STATUS_VALUE_PENDING = 'pending' as const;
/** The settlement failed. */
export const BLOCKCHAIN_PAYMENT_STATUS_VALUE_FAILED = 'failed' as const;

/** Values for {@link ATTR_BLOCKCHAIN_TX_STATUS}. */
export const BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS = 'success' as const;
/** The transaction reverted. */
export const BLOCKCHAIN_TX_STATUS_VALUE_REVERTED = 'reverted' as const;
/**
 * Formerly the status of a confirm span that gave up waiting for its receipt.
 *
 * @deprecated No longer recorded: a confirm span that gave up waiting records `error.type` `timeout` and no
 * `blockchain.tx.status`. The constant is removed in 1.0. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.10.0/docs/adr/0016-timeout-is-an-observer-outcome.md.
 */
export const BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT = 'timeout' as const;
/** Another transaction with the same sender and nonce was mined instead. */
export const BLOCKCHAIN_TX_STATUS_VALUE_REPLACED = 'replaced' as const;

/** Values for {@link ATTR_BLOCKCHAIN_TX_REPLACEMENT_REASON}, as reported by the instrumented library. */
export const BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPRICED = 'repriced' as const;
/** The replacing transaction cancelled the replaced one. */
export const BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_CANCELLED = 'cancelled' as const;
/** The replacing transaction is a different transaction. */
export const BLOCKCHAIN_TX_REPLACEMENT_REASON_VALUE_REPLACED = 'replaced' as const;

/** Reused from OpenTelemetry general conventions. */
export const ATTR_ERROR_TYPE = 'error.type' as const;
/** Fallback {@link ATTR_ERROR_TYPE} value when the error has no name. */
export const ERROR_TYPE_VALUE_OTHER = '_OTHER' as const;
