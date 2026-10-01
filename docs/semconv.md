# Semantic conventions (draft)

Schema version: `0.1.0-dev` · Stability: **development** for everything below.
Rationale: [ADR 0003](adr/0003-attribute-namespace.md). Privacy defaults: [ADR 0004](adr/0004-privacy-defaults.md).

## Spans

| Span name | Kind | Parent | Ends when |
|---|---|---|---|
| `send {blockchain.chain.id}` | CLIENT | active context (e.g. `execute_tool`) | hash returned or send failed |
| `confirm {blockchain.chain.id}` | CLIENT | see below | receipt retrieved, timeout or error; links to `send` or `payment` |
| `payment {blockchain.chain.id}` | CLIENT | active context (e.g. `execute_tool`) | settlement reported or payment failed |

**Confirm span parent**, in order: an explicitly passed context; otherwise the active span (whatever is waiting
for the receipt); otherwise the parent of the `send` span (confirmation in the background); otherwise none.
The link to the `send` span is added whenever the transaction was sent through the same tracker within the link
TTL (default 10 minutes).

**Replaced transactions.** A receipt is recorded on the confirm span of the transaction that was mined. When a
wait for one hash ends with the receipt of another (a transaction with the same sender and nonce replaced it), the
confirm span of the awaited hash ends as `replaced`, without block, gas or fee, and the receipt goes to the confirm
span of the mined hash. If that span is created for this purpose, it has the same parent and start time as the
replaced one and links to it and to both `send` spans when known. Dashboards counting confirmations should exclude
`blockchain.tx.status = replaced`. See [ADR 0008](adr/0008-replaced-transactions.md).

**Payments.** A `payment` span records a payment that the agent authorizes and another party settles on chain, such
as an x402 facilitator: the agent signs, but does not send, the settling transaction, so there is no `send` span
([ADR 0013](adr/0013-x402-payments.md)). It carries what was paid, to whom, and the settlement. A settlement with a
transaction hash makes the payment span the one a confirm span for that hash links to, and whose parent it takes
for confirmation in the background, as a `send` span would.

**One confirm span per transaction and tracker.** Concurrent waits for the same transaction share one confirm span;
its parent is determined by the first wait. A receipt from any wait ends it; a timeout or failure ends it only when
it is the last wait still running, with that wait's outcome. After a receipt, further waits within the link TTL add
no span; after a timeout or failure, a retry gets a new span. See [ADR 0007](adr/0007-confirmation-ownership.md).

### Span status

| Situation | Span | Status | `error.type` | `blockchain.tx.status` |
|---|---|---|---|---|
| Transaction hash returned | send | unset | none | none |
| Signing, simulation or broadcast failed | send | error | the library's error code when the adapter reports one (see below), else error class name, else `_OTHER` | none |
| Receipt with status success | confirm | unset | none | `success` |
| Receipt with status reverted | confirm | error | `reverted` | `reverted` |
| Gave up waiting for the receipt | confirm | error | `timeout` | `timeout` |
| Replaced by another transaction (same sender and nonce) | confirm of the replaced hash | unset | none | `replaced` |
| Receipt with an invalid transaction hash | confirm | error | `_OTHER` | none |
| Retrieving the receipt failed | confirm | error | error class name, else `_OTHER` | none |
| Payment settled | payment | unset | none | none; `blockchain.payment.status` is `settled` |
| Payment settlement pending: transaction known, receipt not seen | payment | unset | none | none; `blockchain.payment.status` is `pending` |
| Payment settlement failed | payment | error | the settling party's reason if it is a short identifier (see below), else `_OTHER` | none; `blockchain.payment.status` is `failed` |
| Creating the payment failed (e.g. signing, or a spending policy refused it) | payment | error | as for a failed send | none |

An adapter whose library reports a stable, machine-readable error code records it as `error.type` of a failed send,
if it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters); `exception.type` stays the class name. The CDP
adapter records the CDP API's error type, e.g. `insufficient_balance`.

Failures with an error object add an `exception` event following the OpenTelemetry exception conventions. By
default it carries only `exception.type`; `exception.message` and `exception.stacktrace` depend on the tracker's
`errorMessages` mode (`off` | `sanitized` | `raw`), and the span status description is the recorded
`exception.message`, if any. See [ADR 0006](adr/0006-error-privacy.md).

Planned: RPC spans from a viem transport wrapper, following the OpenTelemetry [JSON-RPC conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/rpc/json-rpc.md)
(`rpc.system.name = "jsonrpc"`, `rpc.method` from an allowlist of `eth_*` methods). No RPC spans are emitted
today.

## Attributes

| Attribute | Type | Spans | Default | Description |
|---|---|---|---|---|
| `blockchain.system` | string | all | on | `evm` |
| `blockchain.chain.id` | int | all | on | EIP-155 chain id, e.g. `8453` |
| `blockchain.operation.name` | string | all | on | `send` \| `confirm` \| `payment` |
| `blockchain.tx.hash` | string | all | on | `0x`-prefixed tx hash; on a payment span, the settling transaction's, when reported |
| `blockchain.tx.from` | string | send | raw | sender address, subject to address mode |
| `blockchain.tx.to` | string | send | raw | recipient / contract address, subject to address mode |
| `blockchain.tx.value` | string | send | on | value in wei, decimal string |
| `blockchain.tx.nonce` | int | send | on | sender nonce |
| `blockchain.contract.function.name` | string | send | on | decoded function name when an ABI is known |
| `blockchain.contract.function.selector` | string | send | on | 4-byte selector, e.g. `0xa9059cbb` |
| `blockchain.contract.function.arguments` | string | send | off (opt-in) | decoded call arguments as a JSON array, e.g. `["0x2222...2222","1000000"]`: bigints as decimal strings, addresses per address mode, truncated after 4096 characters. Only own enumerable data properties are serialized; `toJSON()` and getters are never called |
| `blockchain.tx.status` | string | confirm | on | `success` \| `reverted` \| `timeout` \| `replaced` |
| `blockchain.block.number` | int | confirm | on | inclusion block |
| `blockchain.tx.gas.used` | int | confirm | on | gas used |
| `blockchain.tx.effective_gas_price` | string | confirm | on | wei, decimal string |
| `blockchain.tx.l1_fee` | string | confirm | on | L1 data fee on OP-stack chains, wei |
| `blockchain.tx.fee` | string | confirm | on | `gas.used × effective_gas_price + l1_fee`, wei; omitted if the gas price is unknown |
| `blockchain.tx.revert.reason` | string | confirm | on | decoded revert reason when available: the `Error(string)` message, `Panic(0x..)`, `ErrorName(arg, ...)` for custom errors with a known ABI, else the 4-byte error selector. See [ADR 0005](adr/0005-revert-reason-replay.md) |
| `blockchain.tx.replacement.hash` | string | confirm | on | on a `replaced` confirm span: hash of the mined transaction that replaced it |
| `blockchain.tx.replacement.reason` | string | confirm | on | on a `replaced` confirm span: `repriced` \| `cancelled` \| `replaced`, as reported by the instrumented library; omitted when it reported none |
| `blockchain.payment.protocol` | string | payment | on | `x402` |
| `blockchain.payment.payer` | string | payment | raw | address that pays, subject to address mode |
| `blockchain.payment.recipient` | string | payment | raw | address that is paid, subject to address mode |
| `blockchain.payment.asset` | string | payment | raw | contract address of the token paid with, subject to address mode |
| `blockchain.payment.amount` | string | payment | on | amount in the asset's smallest unit, decimal string; the settled amount when the settlement reports one |
| `blockchain.payment.status` | string | payment | on | `settled` \| `pending` \| `failed` |
| `x402.scheme` | string | payment | on | x402 payment scheme, e.g. `exact` |
| `x402.resource` | string | payment | on | URL or name of the resource paid for, without query string, fragment or user info |
| `error.type` | string | all | on | see *Span status*; reused from OpenTelemetry general conventions |

Agent identity is recorded with the GenAI conventions `gen_ai.agent.id` and `gen_ai.agent.name`. A field set in the
tracker's static `agent` option always wins; fields it leaves unset are taken from OpenTelemetry Baggage entries with
the same keys, unless `agentFromBaggage` is false ([ADR 0011](adr/0011-agent-identity-precedence.md)). This lets
backends search transactions by agent without joining spans. Baggage is propagated to downstream services; identifiers that
must stay internal belong in the static `agent` option, which is never propagated.

## Privacy

`blockchain.tx.from`, `blockchain.tx.to` and the `blockchain.payment.*` addresses follow the address mode: `raw`
(default), `hashed` (`sha256:` + first 32 hex characters of SHA-256 of the lower-cased address, or a custom
function) or `off`.
A redaction hook runs last on every attribute set; if it throws, only `blockchain.system`, `blockchain.chain.id`,
`blockchain.operation.name`, `blockchain.tx.hash`, `blockchain.tx.status`, `blockchain.tx.replacement.hash`,
`blockchain.tx.replacement.reason`, `blockchain.payment.protocol`, `blockchain.payment.status` and `error.type` are
recorded.
Hashing is pseudonymisation, not anonymisation. See [ADR 0004](adr/0004-privacy-defaults.md). Neither `hashed` nor
`off` hides the parties of a transaction: `blockchain.tx.hash` is always recorded and resolves to them on chain.
The address mode also applies to addresses inside `blockchain.tx.revert.reason`,
`blockchain.contract.function.arguments`, `error.type` and sanitized error messages (`<address>` in `off` mode).
In `hashed` and `off` mode, hex values longer than an address are recorded as `<hex>` in those attributes, because a
padded `bytes32` or ABI-encoded `bytes` value can embed an address. The redaction hook also runs on `error.type` and on `exception` event
attributes; if it throws, only `exception.type` is kept on the event.

Payment values usually come from a remote party (the paid server or the settling party): addresses that are not
`0x`-prefixed 20-byte hex, amounts that are not non-negative integers, hashes that are not 32-byte hex and
identifiers (protocol, scheme, failure reason) that are not short identifiers are not recorded. `x402.resource` is
recorded without its query string, fragment and user info, which can carry credentials.

## Change policy

Additions are minor changes. Renames and removals keep the old attribute emitted for at least one minor release,
are announced in the CHANGELOG, and bump the schema version.
