/**
 * Attribute keys emitted by hashspan.
 *
 * Stability: development. See docs/semconv.md for definitions and value types.
 * These names are a public contract: changes follow the deprecation policy in AGENTS.md.
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
export const ATTR_BLOCKCHAIN_BLOCK_NUMBER = 'blockchain.block.number' as const;
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_NAME = 'blockchain.contract.function.name' as const;
export const ATTR_BLOCKCHAIN_CONTRACT_FUNCTION_SELECTOR =
  'blockchain.contract.function.selector' as const;

/** Values for {@link ATTR_BLOCKCHAIN_SYSTEM}. */
export const BLOCKCHAIN_SYSTEM_VALUE_EVM = 'evm' as const;

/** Values for {@link ATTR_BLOCKCHAIN_OPERATION_NAME}. */
export const BLOCKCHAIN_OPERATION_NAME_VALUE_SEND = 'send' as const;
export const BLOCKCHAIN_OPERATION_NAME_VALUE_CONFIRM = 'confirm' as const;

/** Values for {@link ATTR_BLOCKCHAIN_TX_STATUS}. */
export const BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS = 'success' as const;
export const BLOCKCHAIN_TX_STATUS_VALUE_REVERTED = 'reverted' as const;
export const BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT = 'timeout' as const;

/** Reused from OpenTelemetry general conventions. */
export const ATTR_ERROR_TYPE = 'error.type' as const;
/** Fallback {@link ATTR_ERROR_TYPE} value when the error has no name. */
export const ERROR_TYPE_VALUE_OTHER = '_OTHER' as const;
