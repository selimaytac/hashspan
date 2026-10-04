# Troubleshooting

Organised by what you see in your backend. Each entry says why it happens and how to fix it, and links to the place
where the behaviour is defined. For the setups that were checked, see [integrations](integrations.md).

## No hashspan spans at all

- **No tracer provider is registered.** hashspan records through `@opentelemetry/api`, which drops spans until an
  OpenTelemetry SDK registers a provider. Start the SDK before your agent sends anything, or pass `tracerProvider`
  ([core options](../packages/core/README.md#options)).
- **The client that sends was not extended.** Only clients extended with `withHashspan()` are traced, and a library
  that builds its own client or calls viem's actions as functions (`sendTransaction(client, ...)`) bypasses the
  extension ([libraries that take a viem client](integrations.md#libraries-that-take-a-viem-client)). For a
  transaction you only learn the hash of, use
  [`watch()`](../packages/viem/README.md#transactions-sent-elsewhere).
- **Another extension was applied after `withHashspan()`** and replaced the traced actions
  ([apply it last](../packages/viem/README.md#apply-it-last)).
- **User operations or call batches are missing with a tracker you passed yourself.** A tracker from an older
  `@hashspan/core` records only what that core supports; the calls are passed on untraced
  ([viem options](../packages/viem/README.md#usage)).
- **x402 payments are missing.** x402 v1 payments and networks other than `eip155` are not traced, and a hook of
  your own registered before hashspan's can keep it from seeing the outcome
  ([x402 usage](../packages/x402/README.md#usage), [recorded](../packages/x402/README.md#recorded)).
- **A span processor filters them out.** Langfuse's `LangfuseSpanProcessor` exports by default only GenAI and known
  LLM spans, and drops hashspan's spans without an agent identity and its JSON-RPC spans, logging that at debug level
  only ([keep them](backends.md#with-langfusespanprocessor)).

## Spans in a separate trace from the agent's

hashspan's spans are children of the span that is active when the transaction is sent.

- **No span is active at the call.** Run the call inside your framework's tool span, or inside an active span of
  your own ([agent frameworks](integrations.md#agent-frameworks)).
- **The framework records tool spans without making them active**, as OpenInference's LangChain JS and OpenAI Agents
  instrumentations do: run the tool's function in an active span of your own
  ([agent frameworks](integrations.md#agent-frameworks)).
- **Mastra without observability:** the send and confirm spans then start traces of their own; configure its
  OpenTelemetry bridge ([agent frameworks](integrations.md#agent-frameworks)).
- **A confirm span is not linked to its send span.** Clients extended with different `withHashspan()` results have
  different trackers: reuse one result for every client of an agent ([viem usage](../packages/viem/README.md#usage)),
  and give `@hashspan/cdp` and `@hashspan/x402` the same `tracker`. Without the link, the fee sample of an x402
  settlement is also recorded as paid by its sender, not with `blockchain.fee.payer` `facilitator`. Links are kept for the tracker's `linkTtlMs`
  (10 minutes by default; [core options](../packages/core/README.md#options)).

## A confirm span with no send span next to it

A confirm span usually sits next to its send span, under the same parent: the span active at the wait, or the send
span's parent for a confirmation in the background or through `watch()`
([confirm span parent](semconv.md#spans)). When no span was active at the send, the send span has no
parent, and the confirm span then starts a trace of its own: only its span link relates it to the send.

- **The backend keeps no span links.** Langfuse does not store them, so a confirm span in a trace of its own shows no
  relation to its send there ([which backends keep links](backends.md#span-links)). Run the send inside an active
  span, so that both spans share a parent and a trace, or relate them by the key both carry:

  | Span | Key on both spans |
  |---|---|
  | transaction (`send`, `confirm`; a `payment` span carries its settlement's) | `blockchain.tx.hash` |
  | user operation | `blockchain.user_operation.hash`, with `blockchain.chain.id` |
  | call batch | `blockchain.call_batch.id` |

  In Grafana Tempo, for example, `{span.blockchain.tx.hash = "0x…"}` finds the trace of the send and the trace of the
  confirm span.
- **The confirm span has no link either.** See [a confirm span is not linked to its send span](#spans-in-a-separate-trace-from-the-agents).

## A send span but no confirm span

- **The process exited before the confirmation ended.** Background confirmations, revert reasons and sealed receipts
  are recorded after your call returned: call `flush()` before shutting the SDK down
  ([shutting down](../packages/viem/README.md#shutting-down)).
- **Nothing waited on a traced client.** A library that waits for receipts on a client of its own records no confirm
  span; use [background confirmation](../packages/viem/README.md#background-confirmation). With `@hashspan/cdp` and
  `@hashspan/x402`, confirmations need a `reader` ([cdp usage](../packages/cdp/README.md#usage),
  [x402 usage](../packages/x402/README.md#usage)).
- **The background confirmation limit was reached.** A transaction sent while `maxBackgroundConfirmations` (256 by
  default) confirmations are polling gets no background confirm span, and a `diag` warning is logged
  ([background confirmation](../packages/viem/README.md#background-confirmation)).
- **A sampler kept the send and dropped the confirm span, or the other way round.** With a parent-based sampler, a
  span follows its parent's decision. A confirm span's parent is the span active when it starts, else the parent of
  its send (the tool span), so a send and its confirm span are sampled together, also when the confirmation ends after
  the tool span (background confirmation, `watch()`, an x402 settlement). They are sampled apart when the confirm span
  gets another parent: `watch()` run inside another trace (the confirm span joins that trace), a hash the tracker did
  not send, or a send it no longer keeps (`maxTrackedTransactions`, `linkTtlMs`), whose confirm span starts a trace of
  its own ([core options](../packages/core/README.md#options)).
- **User operations and call batches** get a confirm span only from a wait you make (`waitForUserOperationReceipt`,
  CDP's `waitForUserOperation`, `waitForCallsStatus`); background confirmation and `watch()` cover transactions only
  ([smart accounts](../packages/viem/README.md#smart-accounts-erc-4337),
  [call batches](../packages/viem/README.md#call-batches-eip-5792)).

A confirm span that gave up waiting is not missing: it ends with error status and `error.type` `timeout`
([semantic conventions](semconv.md#span-status)).

## A confirm span disagrees with the chain after a reorganisation

A confirm span keeps the receipt its wait ended with; what a reorganisation changes afterwards, or during a wait for
several confirmations, is described under [chain reorganisations](semconv.md#spans).

## Fees missing from a confirm span

- **The receipt was a flashblocks preconfirmation** (Base) and no sealed receipt came in time, or `flush()` could
  not wait for it: the span has no `effective_gas_price`, `l1_fee` or `fee`
  ([preconfirmed receipts](../packages/viem/README.md#preconfirmed-receipts-flashblocks)). With `@hashspan/cdp`
  and no reader, a preconfirmed receipt from the SDK's wait is recorded the same way
  ([traced calls](../packages/cdp/README.md#traced)).
- **The receipt has no gas price.** `blockchain.tx.fee` needs `effective_gas_price`
  ([semantic conventions](semconv.md#attributes)).
- **User operations and call batches** record no transaction fee by design: a user operation records its own cost,
  and a call batch none ([semantic conventions](semconv.md#spans)).

## Revert reason missing from a reverted transaction

- **Decoding is off.** `@hashspan/viem` and `@hashspan/cdp` decode by default; `@hashspan/x402` only with
  `decodeRevertReason: true` ([revert reasons](../packages/viem/README.md#revert-reasons),
  [x402 usage](../packages/x402/README.md#usage)).
- **The replay could not reproduce it.** The reason comes from replaying the transaction: a provider without
  historical state cannot replay it, earlier transactions in the same block can change the result, and the replay
  has a timeout (10 s by default). It is best effort
  ([revert reasons](../packages/viem/README.md#revert-reasons)).
- **A custom error shows as a selector.** Pass the contract's ABI (`writeContract` does, `watch()` takes `abi`) to
  decode it by name ([revert reasons](../packages/viem/README.md#revert-reasons)).

## Addresses, arguments or error messages missing

These are privacy defaults, not failures: addresses follow the `address` mode, call arguments need
`recordFunctionArguments`, and error messages need `errorMessages`; a `redact` hook can remove more
([core options](../packages/core/README.md#options), [privacy notes](../packages/core/README.md#privacy-notes)).
