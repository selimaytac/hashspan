# Semantic conventions (draft)

Schema version: `0.1.0-dev` · Stability: **development** for everything below.
Rationale: [ADR 0003](adr/0003-attribute-namespace.md). Privacy defaults: [ADR 0004](adr/0004-privacy-defaults.md).

## Spans

| Span name | Kind | Parent | Ends when |
|---|---|---|---|
| `send {blockchain.chain.id}` | CLIENT | active context (e.g. `execute_tool`) | hash returned or send failed |
| `confirm {blockchain.chain.id}` | CLIENT | context that waits for the receipt | receipt retrieved, timeout or error; links to `send` |

RPC calls made by adapters follow the OpenTelemetry [JSON-RPC conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/rpc/json-rpc.md)
(`rpc.system.name = "jsonrpc"`, `rpc.method` from an allowlist of `eth_*` methods).

## Attributes

| Attribute | Type | Spans | Default | Description |
|---|---|---|---|---|
| `blockchain.system` | string | all | on | `evm` |
| `blockchain.chain.id` | int | all | on | EIP-155 chain id, e.g. `8453` |
| `blockchain.operation.name` | string | all | on | `send` \| `confirm` |
| `blockchain.tx.hash` | string | all | on | `0x`-prefixed tx hash |
| `blockchain.tx.from` | string | send | raw | sender address, subject to address mode |
| `blockchain.tx.to` | string | send | raw | recipient / contract address, subject to address mode |
| `blockchain.tx.value` | string | send | on | value in wei, decimal string |
| `blockchain.tx.nonce` | int | send | on | sender nonce |
| `blockchain.contract.function.name` | string | send | on | decoded function name when an ABI is known |
| `blockchain.contract.function.selector` | string | send | on | 4-byte selector, e.g. `0xa9059cbb` |
| `blockchain.tx.status` | string | confirm | on | `success` \| `reverted` \| `timeout` |
| `blockchain.block.number` | int | confirm | on | inclusion block |
| `blockchain.tx.gas.used` | int | confirm | on | gas used |
| `blockchain.tx.effective_gas_price` | string | confirm | on | wei, decimal string |
| `blockchain.tx.l1_fee` | string | confirm | on | L1 data fee on OP-stack chains, wei |
| `blockchain.tx.fee` | string | confirm | on | total fee paid (execution + L1), wei |
| `blockchain.tx.revert.reason` | string | confirm | on | decoded revert reason when available |

Agent identity is copied from the parent context / OpenTelemetry Baggage when present, using the GenAI conventions:
`gen_ai.agent.id`, `gen_ai.agent.name`. This lets backends search transactions by agent without joining spans.

## Change policy

Additions are minor changes. Renames and removals keep the old attribute emitted for at least one minor release,
are announced in the CHANGELOG, and bump the schema version.
