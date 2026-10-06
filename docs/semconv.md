# Semantic conventions (draft)

Schema version: `0.4.0-dev` · Stability: **development** for everything below.
Rationale: [ADR 0003](adr/0003-attribute-namespace.md). Privacy defaults: [ADR 0004](adr/0004-privacy-defaults.md).

## Spans

| Span name | Kind | Parent | Ends when |
|---|---|---|---|
| `send {blockchain.chain.id}` | CLIENT | active context (e.g. `execute_tool`) | hash returned (a transaction's, or a user operation's) or send failed |
| `confirm {blockchain.chain.id}` | CLIENT | see below | receipt retrieved, timeout or error; links to `send` or `payment` |
| `payment {blockchain.chain.id}` | CLIENT | active context (e.g. `execute_tool`) | settlement reported or payment failed |

**Send span as the active span.** While the call that sends the transaction runs, the send span is the active span,
so spans that wallet, RPC or HTTP instrumentation creates for it nest under the send span. This holds for the viem
adapter's clients with a chain and for the CDP adapter, not for viem clients without a chain, whose send span is
recorded after the call, and not for x402's paid request
([ADR 0015](adr/0015-send-span-as-active-context.md)).

**Confirm span parent**, in order: an explicitly passed context; otherwise the active span (whatever is waiting
for the receipt); otherwise the parent of the `send` span (confirmation in the background); otherwise none.
The link to the `send` span is added whenever the transaction was sent through the same tracker within the link
TTL (default 10 minutes). With no parent, the confirm span is in a trace of its own, related to the send only by the
link; some backends do not keep links ([troubleshooting](troubleshooting.md#a-confirm-span-with-no-send-span-next-to-it)).

**Replaced transactions.** A receipt is recorded on the confirm span of the transaction that was mined. When a
wait for one hash ends with the receipt of another (a transaction with the same sender and nonce replaced it), the
confirm span of the awaited hash ends as `replaced`, without block, gas or fee, and the receipt goes to the confirm
span of the mined hash. If that span is created for this purpose, it has the same parent and start time as the
replaced one and links to it and to both `send` spans when known. Dashboards counting confirmations should exclude
`blockchain.tx.status = replaced`. See [ADR 0008](adr/0008-replaced-transactions.md). A replacement needs the same
sender and nonce: where the instrumented library reports replacements (viem), a receipt of another hash that it did
not report as one, such as an endpoint's answer for an unrelated transaction, is not recorded, and the confirm span
ends with `error.type` `_OTHER`.

**Chain reorganisations.** A confirm span records the receipt its wait ended with and is not revised afterwards: when
a reorganisation removes the receipt's block, the span keeps its status and block number, and a later wait for the
transaction within the link TTL adds no span, as the transaction stays settled (see one confirm span per transaction,
below). A wait with `confirmations` above 1 records the receipt it read last: viem returns the receipt it read first,
so once the wait resolved, the confirm span reads the receipt again (viem). If that receipt is missing or in another
block, it also reads the block at the height of the caller's receipt: when that block has another hash, a reorganisation
during the wait moved the transaction, and the span records the receipt in the new block, or removed it, and the span
ends with error status and `error.type` `not_on_chain`, without `blockchain.tx.status`. A node without that block, a
block that still has the caller's hash, a failed request or an answer that cannot be read keeps the caller's receipt.
The caller's result never changes, and the span ends when the wait resolved
([ADR 0026](adr/0026-receipt-after-several-confirmations.md)). A transaction removed before a wait, `watch()` or
background confirmation read its receipt, and not included again, ends as a timeout.

**Payments.** A `payment` span records a payment that the agent authorizes and another party settles on chain, such
as an x402 facilitator: the agent signs, but does not send, the settling transaction, so there is no `send` span
([ADR 0013](adr/0013-x402-payments.md)). It carries what was paid, to whom, and the settlement. A settlement with a
transaction hash makes the payment span the one a confirm span for that hash links to, and whose parent it takes
for confirmation in the background, as a `send` span would.

`blockchain.payment.status` is recorded only from the settlement the settling party reported; when the client never
learned it, the payment span has none and `error.type` says why.

**User operations.** A user operation of an ERC-4337 smart account has no transaction of its own: a bundler
includes it in a bundle transaction that the bundler sends, together with other operations. It gets the same `send`
and `confirm` spans as a transaction, identified by its chain and `blockchain.user_operation.hash` instead of
`blockchain.tx.hash` ([ADR 0021](adr/0021-user-operations.md)). The send span covers handing the operation to the
bundler, until its hash is returned, and has no `blockchain.tx.*` attribute. The confirm span records the
operation's own outcome and cost (`blockchain.user_operation.*`), and the bundle transaction's `blockchain.tx.hash`
and `blockchain.block.number`; it has no `blockchain.tx.status`, gas or fee, which describe the whole bundle. Parent
and link rules are those of transactions, and confirmations of user operations are kept apart from those of
transactions: a wait for the bundle transaction's own receipt is a separate confirm span. Replacement attribution does
not apply: a bundler that resubmits a bundle keeps the operation's hash.

**Call batches.** A batch of calls handed to a wallet with EIP-5792 `wallet_sendCalls` is identified by its chain and
the batch id the wallet returned (`blockchain.call_batch.id`), and gets the same `send` and `confirm` spans
([ADR 0022](adr/0022-call-batches.md)). The send span covers handing the batch to the wallet, until the id is
returned. The confirm span ends with the status a wait returned: its outcome (`blockchain.call_batch.status`) and
EIP-5792 status code, whether the batch ran atomically, and the hashes of the transactions that carried it; it has no
`blockchain.tx.status`, gas or fee, since wallet receipts lack the L1 fee and may be a bundle transaction shared with
others. A wait that resolves while the batch is pending withdraws, as a timeout does: the span ends without an outcome
only when no other wait is still running, and a later wait gets its own span. Confirmations of batches are kept apart
from those of transactions and user operations. Transactions an account sends itself for a batch (viem's fallback to
`eth_sendTransaction`) are linked to the batch's send span and confirmed as transactions, with their fees.

**One confirm span per transaction and tracker.** Concurrent waits for the same transaction share one confirm span;
its parent is determined by the first wait. A receipt from any wait ends it; a timeout or failure ends it only when
it is the last wait still running, with that wait's outcome. After a receipt, further waits within the link TTL add
no span; after a timeout or failure, a retry gets a new span. The same holds for each user operation and call batch. See
[ADR 0007](adr/0007-confirmation-ownership.md). `blockchain.tx.wait.confirmations` is that of the wait which ended the
span: the one whose receipt ended it, or the last to time out or fail. With background confirmation on, the
background wait (`1`) usually gets the receipt first, so a caller's wait with `confirmations: 12` for the same
transaction is not recorded, as it adds no span of its own.

### Span status

| Situation | Span | Status | `error.type` | `blockchain.tx.status` |
|---|---|---|---|---|
| Transaction hash, user operation hash or call batch id returned | send | unset | none | none |
| Signing, simulation, broadcast or handing to a bundler or wallet failed | send | error | the library's error code when the adapter reports one (see below), else error class name, else `_OTHER` | none |
| Receipt with status success | confirm | unset | none | `success` |
| Receipt with status reverted | confirm | error | `reverted` | `reverted` |
| Pending receipt, of a transaction not on chain yet (a Tempo multisig relay below quorum): withdraws the wait, as a timeout does, and ends the span only when no other wait is running | confirm | unset | none | none |
| Gave up waiting for the receipt (its timeout, or `flush()` gave up) | confirm | error | `timeout` | none; see below |
| A reorganisation during a wait for several confirmations removed the transaction (viem; see [chain reorganisations](#spans)) | confirm | error | `not_on_chain` | none |
| Replaced by another transaction (same sender and nonce) | confirm of the replaced hash | unset | none | `replaced` |
| Receipt with an invalid transaction hash | confirm | error | `_OTHER` | none |
| Receipt of another transaction that is not a reported replacement | confirm | error | `_OTHER` | none |
| Receipt with a status other than success or reverted, or one that cannot be read | confirm | error | `_OTHER` | none |
| Retrieving the receipt failed | confirm | error | error class name, else `_OTHER` | none |
| User operation receipt with success | confirm | unset | none | none; `blockchain.user_operation.success` is `true` |
| User operation receipt without success (its calls reverted) | confirm | error | `reverted` | none; `blockchain.user_operation.success` is `false` |
| User operation receipt without a success flag (the adapter does not know the outcome) | confirm | unset | none | none |
| User operation receipt whose success flag is present but not a boolean | confirm | error | `_OTHER` | none |
| User operation failed without a receipt (e.g. an SDK reports `failed`) | confirm | error | the adapter's error type, else error class name, else `_OTHER` | none |
| Call batch status 200 (confirmed) | confirm | unset | none | none; `blockchain.call_batch.status` is `success` |
| Call batch status 500 (reverted) | confirm | error | `reverted` | none; `blockchain.call_batch.status` is `reverted` |
| Call batch status 600 (partially reverted) | confirm | error | `partially_reverted` | none; `blockchain.call_batch.status` is `partially_reverted` |
| Call batch status 400 (failed without inclusion) | confirm | error | `failed` | none |
| Call batch status with any other code, or none, or one that cannot be read | confirm | error | `_OTHER` | none; `blockchain.call_batch.status_code` keeps an integer code |
| Call batch status 100 (a wait that accepted a pending status) | confirm | unset | none | none; no metric sample is recorded |
| Payment settled | payment | unset | none | none; `blockchain.payment.status` is `settled` |
| Payment settlement pending: transaction known, receipt not seen | payment | unset | none | none; `blockchain.payment.status` is `pending` |
| Payment settlement failed | payment | error | the settling party's reason if it is a short identifier (see below), else `_OTHER` | none; `blockchain.payment.status` is `failed` |
| Creating the payment failed (e.g. signing it) | payment | error | as for a failed send | none |
| Payment response without a settlement | payment | error | `no_settlement` (x402 adapter) | none |
| Payment response that cannot be read | payment | error | `_OTHER` | none |
| Payment outcome never learned (no response before its authorization expired, or flush gave up) | payment | error | `timeout` | none |

**Timeouts.** `blockchain.tx.status` describes the transaction as the chain recorded it. A confirm span that gave up
waiting has error status and `error.type` `timeout`, and no `blockchain.tx.status`: the transaction's outcome is
unknown. Up to 0.4, such spans also recorded `blockchain.tx.status` `timeout`; query `error.type` instead
([ADR 0016](adr/0016-timeout-is-an-observer-outcome.md)).

An adapter whose library reports a stable, machine-readable error code records it as `error.type` of a failed send,
if it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters); `exception.type` stays the class name. The CDP
adapter records the CDP API's error type, e.g. `insufficient_balance`. The viem adapter records the error viem
classified the failure as, under the error it throws: `NonceTooLowError` or `InsufficientFundsError` under a
`TransactionExecutionError` (or `ContractFunctionExecutionError`), a bundler error under a
`UserOperationExecutionError`; when there is none, the thrown class. An error class name is recorded, as `error.type`
and as `exception.type`, only if it is such a short identifier too; any other name is recorded as `_OTHER`.

Failures with an error object add an `exception` event following the OpenTelemetry exception conventions. By
default it carries only `exception.type`; `exception.message` and `exception.stacktrace` depend on the tracker's
`errorMessages` mode (`off` | `sanitized` | `raw`; `sanitized` keeps the first line with URLs cut to their origin, cut to 256 characters and `...`), and the
span status description is the recorded
`exception.message`, if any. See [ADR 0006](adr/0006-error-privacy.md).

**JSON-RPC spans.** With the viem adapter's `traceTransport()`, each provider request is a `CLIENT` span named
after its method (`_OTHER` for a name that is not a method), following the OpenTelemetry
[JSON-RPC conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/rpc/json-rpc.md):
`rpc.system.name = "jsonrpc"`, `rpc.method`, `jsonrpc.protocol.version`, `server.address` and `server.port`, plus
`blockchain.chain.id`; on failure, `error.type` and, for a JSON-RPC error, `rpc.response.status_code`. Parameters,
results, the URL path and error messages are not recorded; the host is recorded as it is, and these spans do not
pass through the redaction hook. Its parent is the active span, such as a `send` span
([ADR 0019](adr/0019-json-rpc-spans.md)). A request is one span however often viem's transport retries it (its
`retryCount`): the attempts run inside that span, and HTTP spans of each attempt, if traced, nest under it. viem
sends `eth_sendRawTransaction` without retries, so a broadcast that gets an HTTP 429 or 503 fails after one attempt,
with or without hashspan.

## Attributes

| Attribute | Type | Spans | Default | Description |
|---|---|---|---|---|
| `blockchain.system.name` | string | send, confirm, payment | on | `evm` |
| `blockchain.chain.id` | int | all | on | EIP-155 chain id, e.g. `8453` |
| `blockchain.operation.name` | string | send, confirm, payment | on | `send` \| `confirm` \| `payment` |
| `blockchain.tx.hash` | string | send, confirm, payment | on | `0x`-prefixed tx hash; on a payment span, the settling transaction's, when reported; on a user operation's confirm span, the bundle transaction's; absent on a user operation's send span |
| `blockchain.tx.from` | string | send | raw | sender address, subject to address mode |
| `blockchain.tx.to` | string | send | raw | recipient / contract address, subject to address mode |
| `blockchain.tx.value` | string | send | on | value in wei, decimal string |
| `blockchain.tx.nonce` | int | send | on | sender nonce, when the sending call passes one (a nonce the wallet or viem picks is not known to the adapter) |
| `blockchain.tx.authorization.count` | int | send | on | number of EIP-7702 authorizations a type 4 transaction carries |
| `blockchain.tx.authorization.addresses` | string[] | send | raw | delegated contract address of each well-formed authorization, subject to address mode, at most 64; `0x000...0` clears a delegation |
| `blockchain.tx.authorization.chain_ids` | int[] | send | on | chain id of each well-formed authorization, in the order of the addresses, at most 64; `0` means valid on every chain |
| `blockchain.contract.function.name` | string | send | on | decoded function name when an ABI is known |
| `blockchain.contract.function.selector` | string | send | on | 4-byte selector, e.g. `0xa9059cbb` |
| `blockchain.contract.function.arguments` | string | send | off (opt-in) | decoded call arguments as a JSON array, e.g. `["0x2222...2222","1000000"]`: bigints as decimal strings, addresses per address mode, truncated after 4096 characters. Only own enumerable data properties are serialized; `toJSON()` and getters are never called; binary data (typed arrays, `ArrayBuffer`) as `0x` hex |
| `blockchain.tx.status` | string | confirm | on | from chain data: `success` \| `reverted` \| `replaced` |
| `blockchain.block.number` | int | confirm | on | inclusion block; for a user operation, the bundle transaction's; for a call batch, the highest among its receipts |
| `blockchain.tx.gas.used` | int | confirm | on | gas used |
| `blockchain.tx.effective_gas_price` | string | confirm | on | price per gas in the chain's fee unit (see the fee table below), decimal string; see the `fee` row for when it is omitted |
| `blockchain.tx.l1_fee` | string | confirm | on | L1 data fee on OP-stack chains, in the chain's fee unit; see the `fee` row for when it is omitted |
| `blockchain.tx.fee` | string | confirm | on | `gas.used × effective_gas_price + l1_fee`, in the chain's fee unit: wei of the native currency, or the token `fee_asset` names (see the fee table below); omitted if the gas price is unknown. The OP Stack operator fee (Isthmus and later) is not included: it is recorded apart as `operator_fee`. Fee attributes come from the sealed receipt, never a flashblocks preconfirmation, and are omitted if only a preconfirmation was seen (see [ADR 0024](adr/0024-sealed-receipt-fees.md)). On the confirm span of a payment's settlement, the fee is the facilitator's, which sent the transaction |
| `blockchain.tx.operator_fee` | string | confirm | on | OP Stack operator fee (Isthmus and later), wei, decimal string; not included in `blockchain.tx.fee`. Recorded only when the receipt carries `operatorFeeScalar` or `operatorFeeConstant`, which a node adds when the chain charges the fee; the viem adapter then reads it from the GasPriceOracle's `getOperatorFee(gasUsed)` at the receipt's block, with one `eth_call`. Like the other fee attributes, it comes from the sealed receipt only, and is omitted for a deposit transaction, which pays none |
| `blockchain.tx.fee_asset` | string | confirm | raw | contract address of the token the fee was paid in, subject to address mode, as the chain reports it (a Celo fee currency, which for a 6-decimal token is its 18-decimal adapter contract; a Tempo fee token); absent when the fee is in the native currency. Recorded with the fee attributes, when `effective_gas_price` is. Taken from the receipt when it names one, else from the send: the viem adapter reads Celo's `feeCurrency` from the sending call, never from `sendRawTransaction`, and Tempo's `feeToken` only from a receipt of type `0x76`; a replacing transaction records its own, never the replaced one's ([ADR 0028](adr/0028-fee-asset.md)) |
| `blockchain.tx.revert.reason` | string | confirm | on | decoded revert reason when available, also of a reverted user operation: the `Error(string)` message, `Panic(0x..)`, `ErrorName(arg, ...)` for custom errors with a known ABI, else the 4-byte error selector. See [ADR 0005](adr/0005-revert-reason-replay.md) |
| `blockchain.tx.replacement.hash` | string | confirm | on | on a `replaced` confirm span: hash of the mined transaction that replaced it |
| `blockchain.tx.replacement.reason` | string | confirm | on | on a `replaced` confirm span: `repriced` \| `cancelled` \| `replaced`, as reported by the instrumented library; omitted when it reported none |
| `blockchain.tx.wait.confirmations` | int | confirm | on | on a transaction's confirm span: the confirmations (blocks, counting the receipt's own) that the wait which ended the span asked for, as the library applies them: a viem wait's or a CDP network-scoped wait's `confirmations` when it is a positive safe integer; `1` when it is omitted, `0`, negative or `NaN`, as viem then waits for one, and for background confirmation and `watch()`; not recorded for any other value, nor when the wait took no count (sync actions, user operations, call batches). A count of blocks is not finality: on a rollup it counts the sequencer's blocks, and block times differ by chain, so read it with `blockchain.chain.id`. Span only, never a metric attribute (see one confirm span per transaction for which wait ends the span) |
| `blockchain.user_operation.hash` | string | send, confirm | on | `0x`-prefixed user operation hash (`userOpHash`), which identifies the operation with the chain id |
| `blockchain.user_operation.sender` | string | send, confirm | raw | address of the smart account, subject to address mode |
| `blockchain.user_operation.entry_point` | string | send, confirm | raw | address of the EntryPoint contract, subject to address mode |
| `blockchain.user_operation.call_count` | int | send | on | number of calls the operation makes, when the adapter knows them |
| `blockchain.user_operation.nonce` | string | confirm | on | the operation's nonce, decimal string (a 192-bit key and a 64-bit sequence number) |
| `blockchain.user_operation.success` | boolean | confirm | on | whether the operation's calls succeeded; the bundle transaction can succeed while they revert |
| `blockchain.user_operation.gas.used` | int | confirm | on | gas the operation used (`actualGasUsed`) |
| `blockchain.user_operation.gas.cost` | string | confirm | on | what the operation paid (`actualGasCost`), wei, decimal string; its share of the bundle, not the bundle transaction's fee; paid by the paymaster when `blockchain.user_operation.paymaster` is recorded |
| `blockchain.user_operation.paymaster` | string | confirm | raw | address of the paymaster that paid for the operation, subject to address mode; absent when none paid |
| `blockchain.call_batch.id` | string | send, confirm | on | the batch id the wallet returned for EIP-5792 `wallet_sendCalls` (`0x`-prefixed hex, at most 8194 characters), truncated after 256 characters; with the chain id, it identifies the batch |
| `blockchain.call_batch.sender` | string | send | raw | address of the account the calls are sent from, subject to address mode |
| `blockchain.call_batch.call_count` | int | send | on | number of calls in the batch |
| `blockchain.call_batch.status` | string | confirm | on | the batch's outcome from chain data: `success` \| `reverted` \| `partially_reverted`; absent for other outcomes, which `error.type` describes |
| `blockchain.call_batch.status_code` | int | confirm | on | the EIP-5792 status code the wallet reported, e.g. `200` confirmed, `500` reverted; spans only, never a metric attribute |
| `blockchain.call_batch.atomic` | boolean | confirm | on | whether the wallet ran the calls atomically |
| `blockchain.call_batch.transaction_hashes` | string[] | confirm | on | hashes of the transactions whose receipts the wallet reported for the batch, de-duplicated, at most 64 |
| `blockchain.operation.subject` | string | none (metrics only) | on | on [metrics](#metrics) of user operations: `user_operation`; of call batches: `call_batch`; absent on those of transactions |
| `blockchain.fee.payer` | string | none (metrics only) | on | on `blockchain.client.fee` samples whose fee the sender of the traced transaction or operation did not pay: `facilitator` for a payment's settlement transaction, `paymaster` for a user operation a paymaster paid for, `sponsor` for a transaction whose receipt names another account as its fee payer (a Tempo `feePayer`); a payment's settlement keeps `facilitator`, also when its fee was sponsored; absent when the sender paid ([ADR 0020](adr/0020-metrics.md)) |
| `blockchain.fee.denomination` | string | none (metrics only) | on | on `blockchain.client.fee` samples whose fee was paid in a token rather than the chain's native currency: `token`, a constant, never an address or a value read from the chain; set whenever `blockchain.tx.fee_asset` is known, in every address mode; absent for the native currency, Arc's USDC included ([ADR 0028](adr/0028-fee-asset.md)) |
| `blockchain.payment.protocol` | string | payment | on | `x402` |
| `blockchain.payment.payer` | string | payment | raw | address that pays, subject to address mode; the settlement's payer only when the payer knew none |
| `blockchain.payment.recipient` | string | payment | raw | address that is paid, subject to address mode |
| `blockchain.payment.asset` | string | payment | raw | contract address of the token paid with, subject to address mode |
| `blockchain.payment.amount` | string | payment | on | amount in the asset's smallest unit, decimal string; the settlement's amount only when the payer knew none |
| `blockchain.payment.settled_amount` | string | payment | on | amount the settling party reports it settled, decimal string, e.g. less than the authorized maximum with x402 `upto`; as reported, not checked |
| `blockchain.payment.verified` | boolean | payment | on | whether the settlement transaction carries this payment (its receipt and, for Permit2, its input), checked by the adapter from the payer's own data; absent when no check was possible ([ADR 0017](adr/0017-x402-payment-verification.md)) |
| `blockchain.payment.status` | string | payment | on | `settled` \| `pending` \| `failed` |
| `x402.scheme` | string | payment | on | x402 payment scheme, e.g. `exact` |
| `x402.resource` | string | payment | origin | the resource paid for, per the tracker's `paymentResource` mode: `origin` (default) records scheme, host and port only, `path` the URL without query string, fragment or user info, `off` nothing; at most 512 characters, and nothing for text whose user info contains `?` or `#` |
| `error.type` | string | all | on | see *Span status*; reused from OpenTelemetry general conventions |

Of this table, JSON-RPC spans carry only `blockchain.chain.id` and `error.type` (see [JSON-RPC spans](#spans)). In `blockchain.tx.*`, `tx` abbreviates transaction, the usual term in this domain; names outside that
namespace spell the word out, as `blockchain.call_batch.transaction_hashes` does.

The parties of each subject are named after the source the values come from:

| Subject | Sender | Recipient | Why |
|---|---|---|---|
| Transaction | `blockchain.tx.from` | `blockchain.tx.to` | the `from` and `to` fields of a JSON-RPC transaction |
| User operation | `blockchain.user_operation.sender` | none | the ERC-4337 `sender`, the smart account; the operation's calls have their own targets |
| Call batch | `blockchain.call_batch.sender` | none | the account the calls are sent from, which can differ from the sender of the transaction that carries them, such as a bundler or relayer |
| Payment | `blockchain.payment.payer` | `blockchain.payment.recipient` | the parties of the payment; the settling party, not the payer, sends the transaction |

The fee fields follow the receipt of each chain family, as the viem adapter reads it (tested in
`packages/viem/test/fee-models.test.ts`):

| Family | `blockchain.tx.l1_fee` | `blockchain.tx.fee` |
|---|---|---|
| Ethereum and other L1s | not recorded | `gas.used × effective_gas_price` |
| OP Stack (Base, OP Mainnet, Celo) and Scroll | the receipt's `l1Fee` | plus `l1_fee`; the OP Stack operator fee is recorded apart, as `blockchain.tx.operator_fee` |
| Arbitrum | not recorded: `gasUsed` already includes the L1 component (`gasUsedForL1`) | `gas.used × effective_gas_price` |
| ZKsync | not recorded | `gas.used × effective_gas_price` |
| Celo, a transaction with a `feeCurrency` (type `0x7b`) | the receipt's `l1Fee` | plus `l1_fee`, in the fee currency, which only the transaction names: `blockchain.tx.fee_asset` is the sending call's `feeCurrency` |
| Tempo (type `0x76`) | not recorded | `gas.used × effective_gas_price`, in attodollars (10^-18 USD), charged in the receipt's `feeToken`, recorded as `blockchain.tx.fee_asset`; viem's Tempo chain declares 6 decimals for its currency, so formatting the fee with it is off by 10^12 |
| Arc | not recorded | `gas.used × effective_gas_price`, in its native currency, USDC with 18 decimals; no `fee_asset`, since the chain id already says what the unit is |

Values are recorded as the receipt gives them, in the chain's fee unit: the unit the chain charges gas in, which is
not always wei of its native currency. Nothing is converted, rounded or formatted with token decimals. When the fee
was paid in a token, the confirm span names it in `blockchain.tx.fee_asset` and the fee sample carries
`blockchain.fee.denomination` `token`, so a dashboard can tell these samples from fees in the native currency
([ADR 0028](adr/0028-fee-asset.md)). A Celo transaction whose fee currency the adapter does not see, one sent with
`sendRawTransaction` or sent elsewhere and confirmed with `watch()`, records no asset and no marker: its sample counts
as native.

Agent identity is recorded with the GenAI conventions `gen_ai.agent.id` and `gen_ai.agent.name`. A field set in the
tracker's static `agent` option always wins; fields it leaves unset are taken from OpenTelemetry Baggage entries with
the same keys, unless `agentFromBaggage` is false ([ADR 0011](adr/0011-agent-identity-precedence.md)). A Baggage
value is recorded only if it has at most 128 letters, digits, spaces and `_ . : @ / -`. This lets
backends search transactions by agent without joining spans. Baggage is propagated to downstream services; identifiers that
must stay internal belong in the static `agent` option, which is never propagated.

## Metrics

The tracker records these histograms through the meter provider (the global one unless `meterProvider` is given),
so every adapter gets them ([ADR 0020](adr/0020-metrics.md)). Their attributes are low-cardinality only:
`blockchain.system.name`, `blockchain.chain.id`, what the sample is about and
its outcome, as the table lists them; never an address, a hash or the agent identity. Samples of user operations
([ADR 0021](adr/0021-user-operations.md)) and call batches ([ADR 0022](adr/0022-call-batches.md)) carry
`blockchain.operation.subject`; a call batch's raw status code is never recorded on metrics, and batches record no fee.

| Metric | Instrument | Unit | Attributes | Recorded when |
|---|---|---|---|---|
| `blockchain.client.send.duration` | histogram | `s` | chain; `blockchain.operation.subject` for a user operation or call batch; `error.type` if the send failed | a send span ends with a hash or id, or fails: from the start of the sending call until then |
| `blockchain.client.confirmation.duration` | histogram | `s` | chain; `blockchain.operation.subject` for a user operation or call batch; the outcome from chain data, `blockchain.tx.status` (for a user operation, `blockchain.user_operation.success`; for a call batch, `blockchain.call_batch.status`), else `error.type` (`timeout`, `not_on_chain`, an adapter's error type, an error class name, or `_OTHER`) | a confirm span ends: from the start of the wait until the receipt or batch status, a replacement, a timeout or a failure; not for a call batch that ended while still pending, nor for a transaction whose receipt was pending |
| `blockchain.client.fee` | histogram | `{wei}` | chain; `blockchain.operation.subject` for a user operation; `blockchain.tx.status` (for a user operation, `blockchain.user_operation.success`); `blockchain.fee.payer` when someone other than the sender paid; `blockchain.fee.denomination` when the fee was paid in a token | a receipt with an effective gas price is recorded: `blockchain.tx.fee` as a number, without the OP Stack operator fee, which no metric records; for a user operation, a receipt with its cost: `blockchain.user_operation.gas.cost` |

A confirmation sample is a success when its outcome from chain data says so: `blockchain.tx.status` `success`,
`blockchain.user_operation.success` `true` or `blockchain.call_batch.status` `success`. Count successes across
subjects by matching these values, not by the absence of `error.type`: a sample with an outcome from chain data, such
as `reverted` or `replaced`, carries no `error.type`.

Bucket boundaries are given as advice: 0.05 s to 300 s for durations, and one bucket per power of ten from 10^8 to
10^18 wei for fees. Fees above 2^53 wei lose precision as numbers; the span attribute keeps the exact value.

On metrics, `error.type` is kept only when it is an error class name of letters ending in `Error` (such as
`NonceTooLowError`) or a lower-case code of letters and underscores (such as `timeout` or
`insufficient_balance`); any other value, which could carry an identifier,
an address or a number, is recorded as `_OTHER`. The span keeps its own `error.type`.

## Privacy

`blockchain.tx.from`, `blockchain.tx.to`, the `blockchain.payment.*` addresses, the user operation's sender,
EntryPoint and paymaster, `blockchain.call_batch.sender` and `blockchain.tx.authorization.addresses` follow the
address mode: `raw` (default, the address in
lower case), `hashed` (`sha256:` + first 32 hex characters of SHA-256 of the lower-cased address, or a custom
function) or `off`. Neither depends on how the source wrote the address, so one address has one value on every
span, whether it came checksummed from the call's arguments or lower-cased from a receipt.
A redaction hook runs last on every attribute set of the tracker's spans, not on metrics or JSON-RPC spans; if it
throws or returns something other than an attributes object, only `blockchain.system.name`, `blockchain.chain.id`, `blockchain.operation.name`, `blockchain.tx.hash`, `blockchain.tx.status`, `blockchain.tx.replacement.hash`,
`blockchain.tx.replacement.reason`, `blockchain.payment.protocol`, `blockchain.payment.status`,
`blockchain.payment.verified`, `blockchain.user_operation.hash`, `blockchain.user_operation.success`,
`blockchain.call_batch.id`, `blockchain.call_batch.status` and `error.type` are recorded.
Hashing is pseudonymisation, not anonymisation. See [ADR 0004](adr/0004-privacy-defaults.md). Neither `hashed` nor
`off` hides the parties of a transaction: `blockchain.tx.hash` is always recorded and resolves to them on chain, as
`blockchain.user_operation.hash` does for a user operation.
The address mode also applies to addresses inside `blockchain.tx.revert.reason`,
`blockchain.contract.function.arguments`, `x402.resource`, `error.type` and sanitized error messages (`<address>` in `off` mode).
In `hashed` and `off` mode, hex values longer than an address are recorded as `<hex>` in those attributes, because a
padded `bytes32` or ABI-encoded `bytes` value can embed an address. What a value longer than its bound becomes is
listed under [Bounds](#bounds). The redaction hook also runs on `error.type` and on `exception` event
attributes; if it throws, only `exception.type` is kept on the event.

Payment values usually come from a remote party (the paid server or the settling party): addresses that are not
`0x`-prefixed 20-byte hex, amounts that are not non-negative integers, hashes that are not 32-byte hex and
identifiers (protocol, scheme, failure reason) that are not short identifiers are not recorded. Paths of paid
APIs often carry user or account identifiers, so `x402.resource` records only the origin by default; with
`paymentResource: 'path'` it records the path too, never the query string, fragment or user info, which can carry
credentials ([ADR 0004](adr/0004-privacy-defaults.md)). A user operation's hash and receipt come from the bundler and are checked the
same way; its nonce, gas and cost may also be `0x` hex quantities.
What a caller or an adapter passes to the tracker is checked as well ([ADR 0025](adr/0025-untrusted-input.md)): a
call without a positive safe integer chain id, or a confirmation without a 32-byte hex hash, records no span; a send
records only well-formed addresses, a value that is a non-negative integer of at most 256 bits, a nonce that is a
non-negative safe integer, a Solidity function name and a 4-byte selector. Nothing is recorded from a transaction
receipt whose block number or gas used is not a non-negative safe integer; its gas price and L1 fee are recorded only
as non-negative integers, and `blockchain.tx.fee` only when every part of it is known.

The EIP-7702 attributes describe what the sent transaction asks for, not what took effect: the protocol skips an
authorization whose signature, nonce or chain id does not hold, without failing the transaction. The account that
signed each authorization (its authority) is not recorded; it is often the sender, but not in a sponsored
transaction. The signatures and the authorities' nonces are never recorded.

## Bounds

Values come from parties hashspan does not control, and the OpenTelemetry SDK does not bound attribute values by
default, so each value read from them has a bound ([ADR 0025](adr/0025-untrusted-input.md)); the hostile-input tests
of each package check the bounds against the values that split at them.

| Value | Bound | A longer value becomes |
|---|---|---|
| `blockchain.tx.revert.reason` | 1024 characters | its first 1024 characters, followed by `...`; a hex value the cut would split is dropped whole. A reason an adapter already cut this way is kept as it is |
| `error.type` and `exception.type` from an error's name | 64 characters of `[A-Za-z0-9_.-]` | `_OTHER` |
| `exception.message` in `sanitized` mode | 256 characters of the first line, sanitized from its first 4096 characters | its first 256 characters, followed by `...`; a hex value the cut would split is dropped whole. Text past the 4096th character of the first line is not recorded (a hex value cut there is recorded as if whole, a URL cut there before its path as `<url>`) |
| `blockchain.contract.function.arguments` | 4096 characters, nesting depth 32 | the JSON up to the value that crosses 4096 characters, cut there and followed by `...`; a hex value the cut would split is dropped whole; arguments nested deeper are not recorded |
| `blockchain.contract.function.selector` of `writeContract` | an ABI of 10 000 items and 100 000 copied values; for an overloaded function, 100 000 copied argument values | no selector; past the ABI bound, no ABI is used for telemetry either, so custom errors in the revert reason show as their selector |
| `x402.resource` | 512 characters | its first 512 characters, followed by `...`; a hex value the cut would split is dropped whole |
| `blockchain.call_batch.id` | 256 characters | its first 256 characters; an id that is not hex or longer than 8194 characters is not recorded |
| `blockchain.tx.authorization.addresses` and `.chain_ids` | 64 entries | the first 64 well-formed entries; `blockchain.tx.authorization.count` keeps the full length, and no further entry is read |
| `blockchain.call_batch.transaction_hashes` | 64 hashes | the first 64 distinct well-formed hashes among the first 64 receipts of a status, or of the hashes a send returned; no further entry is read, and `blockchain.block.number` is the highest among those receipts |
| x402 payments waiting for their response | 1000 per `withHashspan()` | the oldest payment span ends as `timeout` |
| Background confirmations polling at once | 256 per `withHashspan()` (`maxBackgroundConfirmations`) | the transaction gets no background confirm span; a `diag` warning is logged |
| Sent transactions, user operations and call batches kept for links | 10 000 each, for 10 minutes (`maxTrackedTransactions`, `linkTtlMs`) | the oldest is forgotten: its confirm span has no link |

## Change policy

These conventions stay `development` after 1.0; the public API is what 1.0 freezes
([ADR 0027](adr/0027-what-1-0-freezes.md)). A change to them follows these rules:

- **Additions are minor changes:** a new attribute, metric or enum value. Consumers handle values they do not know,
  as `_OTHER` already asks.
- **Renames and removals** of an attribute, a metric or an enum value record the old and the new name side by side
  for at least one minor release, are announced in the CHANGELOG, and bump the schema version. A span name, which
  cannot be recorded twice, changes only in a minor release, announced the same way.
- **Meaning is not changed in place:** a new meaning gets a new name, and the old one is deprecated as above.
- **Value forms are part of each attribute:** the type and form in the tables above change only through the same
  steps.
- An exported constant for a deprecated name stays exported, marked `@deprecated`, until the next major release.
