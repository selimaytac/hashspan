# Semantic conventions (draft)

Schema version: `0.1.0-dev` · Stability: **development** for everything below.
Rationale: [ADR 0003](adr/0003-attribute-namespace.md). Privacy defaults: [ADR 0004](adr/0004-privacy-defaults.md).

## Spans

| Span name | Kind | Parent | Ends when |
|---|---|---|---|
| `send {blockchain.chain.id}` | CLIENT | active context (e.g. `execute_tool`) | hash returned or send failed |
| `confirm {blockchain.chain.id}` | CLIENT | see below | receipt retrieved, timeout or error; links to `send` |

**Confirm span parent**, in order: an explicitly passed context; otherwise the active span (whatever is waiting
for the receipt); otherwise the parent of the `send` span (confirmation in the background); otherwise none.
The link to the `send` span is added whenever the transaction was sent through the same tracker within the link
TTL (default 10 minutes).

### Span status

| Situation | Span | Status | `error.type` | `blockchain.tx.status` |
|---|---|---|---|---|
| Transaction hash returned | send | unset | none | none |
| Signing, simulation or broadcast failed | send | error | error class name, else `_OTHER` | none |
| Receipt with status success | confirm | unset | none | `success` |
| Receipt with status reverted | confirm | error | `reverted` | `reverted` |
| Gave up waiting for the receipt | confirm | error | `timeout` | `timeout` |
| Retrieving the receipt failed | confirm | error | error class name, else `_OTHER` | none |

Failures with an error object add an `exception` event following the OpenTelemetry exception conventions. By
default it carries only `exception.type`; `exception.message` and `exception.stacktrace` depend on the tracker's
`errorMessages` mode (`off` | `sanitized` | `raw`), and the span status description is the recorded
`exception.message`, if any. See [ADR 0006](adr/0006-error-privacy.md).

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
| `blockchain.tx.fee` | string | confirm | on | `gas.used × effective_gas_price + l1_fee`, wei; omitted if the gas price is unknown |
| `blockchain.tx.revert.reason` | string | confirm | on | decoded revert reason when available: the `Error(string)` message, `Panic(0x..)`, `ErrorName(arg, ...)` for custom errors with a known ABI, else the 4-byte error selector. See [ADR 0005](adr/0005-revert-reason-replay.md) |
| `error.type` | string | all | on | see *Span status*; reused from OpenTelemetry general conventions |

Agent identity is recorded with the GenAI conventions `gen_ai.agent.id` and `gen_ai.agent.name`, taken from
OpenTelemetry Baggage entries with the same keys, or from the tracker's static `agent` option. This lets backends
search transactions by agent without joining spans.

## Privacy

`blockchain.tx.from` / `blockchain.tx.to` follow the address mode: `raw` (default), `hashed`
(`sha256:` + first 32 hex characters of SHA-256 of the lower-cased address, or a custom function) or `off`.
A redaction hook runs last on every attribute set; if it throws, only `blockchain.system`, `blockchain.chain.id`,
`blockchain.operation.name`, `blockchain.tx.hash`, `blockchain.tx.status` and `error.type` are recorded.
Hashing is pseudonymisation, not anonymisation. See [ADR 0004](adr/0004-privacy-defaults.md).
The address mode also applies to addresses inside `blockchain.tx.revert.reason`, `error.type` and sanitized error
messages (`<address>` in `off` mode). The redaction hook also runs on `error.type` and on `exception` event
attributes; if it throws, only `exception.type` is kept on the event.

## Change policy

Additions are minor changes. Renames and removals keep the old attribute emitted for at least one minor release,
are announced in the CHANGELOG, and bump the schema version.
