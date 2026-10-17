# 0029. MPP payments as payment spans

- Status: proposed
- Date: 2026-10-18

## Context

The Machine Payments Protocol (MPP) lets an HTTP API ask for payment, as x402 does: the server answers
`402 Payment Required` with a challenge in a `WWW-Authenticate: Payment` header, the client pays and retries with an
`Authorization: Payment` credential, and the server answers with a `Payment-Receipt` header. Its TypeScript SDK is
`mppx` (wevm, MIT). On Tempo, a payment is a TIP-20 token transfer in a Tempo transaction (type `0x76`). Facts from
the source of mppx 0.13.5 (`dist/client/internal/Fetch.js`, `dist/tempo/client/Charge.js`,
`dist/tempo/server/Charge.js`, `dist/tempo/Attribution.js`) and from runs on Anvil in Tempo mode (#438):

- **Client events.** `Mppx.create()` returns a client with `on(name, handler)` and `onChallengeReceived`,
  `onCredentialCreated`, `onPaymentResponse` and `onPaymentFailed` (since 0.6.21). For one paid request they run in
  the order `challenge.received`, `credential.created`, the paid request, then `payment.response` or
  `payment.failed`. Every payment made through the client's `fetch`, or the global `fetch` it polyfills, reaches them.
  The SDK calls observers inside `try`/`catch`, so a throwing observer cannot change the payment, but it awaits them
  on the request path. Only a value returned from `challenge.received` steers the payment: it supplies a credential.
- **Payloads are frozen copies.** Each event gets a `structuredClone` of the challenge, and a `clone()` of the
  `Response` and of a `Request` input. The objects of two events are never identical, so one payment is identified
  only by its `challenge.id`, which the server chooses, and by the credential string. Every payload with a response
  carries a clone: the 402 response in `challenge.received` and `credential.created`, the paid response in
  `payment.response` (cloned only when a `payment.response` observer exists, since an unread clone of a stream buffers
  it). A clone whose body nobody reads or cancels keeps buffering what the original reads.
- **What reaches no event.**
  - A paid request answered with a status from 300 to 499 other than 402 is returned to the caller without an event.
  - A paid request answered with 402 again starts a new round (up to `maxPaymentRetries`, default 3) or is returned
    without an event.
  - `payment.response` runs only for a 2xx response.
  - A 5xx response, or a paid request that throws, reaches `payment.failed` with a `PaymentOutcomeUnknownError`
    (0.13.5) that carries the challenge, the credential and, when the credential determines it, the
    `transactionHash`.
  - A failure inside the method's `createCredential` (the client's own policy and spending limits, signing, a push
    transaction that fails) reaches `payment.failed` after `challenge.received` and without `credential.created`.
  - A failure before `challenge.received` (no method for the challenge, an expired challenge) reaches
    `payment.failed` with a challenge no observer saw before.
- **Push and pull.** A Tempo `charge` is settled in one of two modes. The client's mode is `push` for JSON-RPC
  (wallet) accounts and `pull` for local accounts, unless the user or the challenge's `supportedModes` decides.
  - *Push* (credential payload `type: "hash"`): the payer broadcasts the transfer itself with
    `sendTransactionSync(client, ...)` before `credential.created`, and sends its hash. A payer client extended with
    `@hashspan/viem`'s `withHashspan()` and passed through mppx's `getClient` records a send and a confirm span for
    it (#438), as siblings in the caller's context: the transaction is sent inside the SDK, where an observer cannot
    set a context. A JSON-RPC account pushes with `sendCallsSync` instead.
  - *Pull* (`type: "transaction"`): the payer signs the Tempo transaction and the server broadcasts it. The
    transaction's `from` is the payer, which also pays its fee, unless the challenge sets `feePayer: true`: then the
    server co-signs as fee payer, and the final hash is known only from the receipt. For an unsponsored transaction,
    the hash is the `keccak256` of the signed, canonically serialized transaction, which mppx itself derives (not
    exported); the run in #438 confirmed that it equals the receipt's `reference`.
  - Zero-amount challenges are answered with a signed proof (`type: "proof"`): no transaction.
- **The receipt.** `Payment-Receipt` (base64url JSON) carries `method`, `reference` (the transaction hash for Tempo),
  `status` (always `success`; failures come back as a 402 with problem details), `timestamp` and optional
  `fundingCurrency` and `externalId`. A server with `waitForConfirmation: false` answers before the transaction is
  mined. Amount, currency, recipient, splits and chain are in the challenge's `request`; the payer's address and chain
  are in the credential's `source` (`did:pkh:eip155:<chainId>:<address>`), which the payer's own client writes.
- **The transfer names the challenge.** The client always transfers the primary amount with `transferWithMemo` and
  an attribution memo: bytes 0 to 3 are the tag `keccak256("mpp")`, byte 4 the version, bytes 5 to 14 a fingerprint of
  the challenge's `realm`, bytes 25 to 31 the first 7 bytes of `keccak256(challenge.id)` (since 0.5.5; servers
  require it since 0.11.0). A TIP-20 `transferWithMemo` emits `Transfer` and `TransferWithMemo` side by side, which
  the server's check pairs into one transfer. Up to 10 splits (`methodDetails.splits`) are further transfers, each of
  its amount; the primary recipient gets the amount less the splits.
- **The rest of MPP.** Sessions (payment channels with off-chain vouchers, settled later by the server),
  subscriptions, the `evm` and `stripe` methods and the x402 compatibility path use the same events with another
  `challenge.intent` or `challenge.method`. A session deposit is an on-chain transaction that is not a payment to the
  payee, the trap of #436.
- **The package.** mppx is 0.x and moves fast: 117 releases in 8 months, with breaking changes in minor lines
  (0.5.5, 0.8.0, 0.8.16, 0.9.0, 0.11.0, 0.13.0). The event names have not changed since 0.6.21; the payload details
  this record relies on (`PaymentOutcomeUnknownError.transactionHash`, the observer-gated response clone) date from
  0.13.5. It requires `viem >=2.57.1`.
- **The core today.** A payment span's `link(hash)` and `end({ hash })` mark the hash's confirm span as a payment's
  settlement with fee payer `facilitator` (ADR 0013), unless the tracker already links the hash, such as to one of its
  own sends. That is right for x402, where the facilitator sends the transaction, and wrong for MPP, where its `from`
  is the payer in both modes.

## Decision

- **A new package, `@hashspan/mpp`,** with `withHashspan(mppx, options)` for the client returned by mppx's
  `Mppx.create()`, mirroring `@hashspan/x402` (ADR 0013). Options: the tracker options, `reader`, `confirmTimeoutMs`
  and `decodeRevertReason` (default `false`, as for x402). It registers observers with `on()` and returns a handle
  with `flush()` (ADR 0010); a second call on the same client returns the first handle and logs a warning. It detects
  the event API by feature (`typeof mppx.on === 'function'`); without it, it traces nothing and logs a `diag` warning.
  Peer dependencies: `@opentelemetry/api`, `mppx` (`~0.13.5`, widened only after the weekly range run passes), and
  `viem` (`^2.57.1`, mppx's own floor) for the `reader`, as in ADR 0012.
- **Observers, not wrapping.** No method is replaced. Every observer catches its own failures and logs them via
  `diag`; the `challenge.received` observer never returns a value, so it never supplies a credential.
- **Scope of v1: Tempo `charge`, push and pull.** A challenge whose `method` is not `tempo` or whose `intent` is not
  `charge` is passed through untraced, with a `diag` message once per method and intent. A proof credential
  (zero amount) records nothing: no value moved.
- **One `payment {chainId}` span per paid request, not a `send` span.** It records the protocol's view of the
  payment, as for x402; the transaction belongs to `@hashspan/viem`'s spans.
  - `challenge.received` captures the start time and the active context (for example the agent's tool span), keyed
    by `challenge.id`. `credential.created` creates the span with them, so a push transaction sent in between falls
    inside the span's time.
  - The span records `blockchain.operation.name` `payment` and `blockchain.payment.protocol` `mpp`. The chain and the
    payer come from the credential's `source`, which the payer's client wrote. The recipient, asset (`currency`) and
    amount come from the challenge's `request`, with addresses per the address mode (ADR 0004). A chain that differs
    from the `reader`'s means no confirmation and no verification for that payment (#254).
  - New attributes, under `mpp.*` for MPP's own fields, as ADR 0013 does for x402: `mpp.method` (`tempo`),
    `mpp.intent` (`charge`), `mpp.mode` (`push` | `pull`, from the credential's payload type), `mpp.challenge.id`
    (validated against a short identifier pattern and bounded, spans only) and `mpp.resource`, with the meaning,
    modes and bound of `x402.resource` (origin by default; `paymentResource`; 512 characters). None becomes a metric
    attribute.
- **Who sends the settlement: a core minor.** `PaymentInput` gains an optional field saying that the payer is the
  settlement transaction's `from` (proposed name `sender: 'payer'`; settled in the implementation's API report). With
  it, the core:
  - links the hash without the `facilitator` fee payer: the fee sample then carries `blockchain.fee.payer` `sponsor`
    when the receipt names another fee payer (a sponsored pull), and none when the payer paid;
  - starts the payment span with a span link to the tracker's own send span of that hash when one exists (push
    through a traced client), so the payment span and the payer's send and confirm spans point at each other.

  The `mpp` details (method, intent, mode, challenge id, resource) arrive as an optional `PaymentInput.mpp`, beside
  `x402`. Both fields are additions (ADR 0014). The adapter detects them through a member added with them; with an
  older core it traces no MPP payment and logs a `diag` warning once, since its spans would label the payer's fee as a
  facilitator's.
- **The payer's own hash wins.** For push, the hash is the credential's `payload.hash`. For an unsponsored pull, the
  adapter derives it from the signed transaction as mppx does: a `0x76` envelope, signed by the payer, without a fee
  payer marker, serialized canonically; when it cannot tell, the payment is handled as sponsored. A known hash is
  linked with `link(hash)` at `credential.created`, recorded as `blockchain.tx.hash`, and confirmed instead of a
  `reference` that differs. A sponsored pull takes its hash from the receipt's `reference`, as reported. In either
  case the `reference` is untrusted (ADR 0025): a value that is not a 32-byte hex hash is not recorded.
- **Outcomes**, built from the paths of `Fetch.js` above:

  | What the client sees | Payment span |
  |---|---|
  | `payment.response` with a readable `Payment-Receipt` | `blockchain.payment.status` `settled`, the hash as above |
  | `payment.response` without a `Payment-Receipt`, or with one that cannot be read | error, `error.type` `no_settlement` or `_OTHER`, as for x402 |
  | `payment.failed` with `PaymentOutcomeUnknownError` and a hash (a 5xx, or the paid request threw) | `pending` with the payer's hash, resolved by the confirm span |
  | the same without a hash (sponsored pull) | error, `error.type` from the error, no status |
  | `payment.failed` after `challenge.received` without `credential.created` (policy, spending limit, signing, a failed push send) | error, `error.type` from the error, no hash, as a failed send; the adapter does not tell policy refusals apart |
  | `payment.failed` for a challenge no observer saw | nothing |
  | no event: 3xx, a 4xx, a 402 after payment | error, `error.type` `timeout`, no status (ADR 0016), once the challenge's `expires` (bounded) or, without one, the client's default validity of 25 seconds, plus a grace period, has passed |
  | too many payments open, or `flush()` gives up | the oldest ends as `timeout` |

  At most 1000 payments are open per `withHashspan()` result, counting the start state of `challenge.received`, as
  for x402: the server decides how many challenges arrive. A later event for the same `challenge.id` and credential
  joins the open span; a repeated `challenge.received` keeps the first start time, and a second credential for an id
  that is open starts no second span (a hostile server repeating ids gets one span per id). The bounds are named
  constants listed in docs/semconv.md.
- **Confirmation only with a reader.** With a `reader` for the chain, the adapter calls `watch()` for every
  settlement or pending payment with a hash, as the x402 adapter does; a confirm span the tracker already has for
  that hash (a traced push) is joined, not duplicated (ADR 0007). The confirm span records block, gas, the fee in
  `fee_asset` (ADR 0028) and whether the fee was sponsored, and resolves a server that answered before the
  transaction was mined. Without a reader, only the payment span is recorded, with the status as the server reported
  it. `flush()` awaits the work. Reverted settlements are replayed for their reason only with
  `decodeRevertReason: true`.
- **Verified payment, the ADR 0017 equivalent.** With a reader, the payment span records
  `blockchain.payment.verified` from the settlement receipt (`watch()`'s `onReceipt`), ending once the check is done
  with its end time unchanged (ADR 0017). Inputs come only from the payer's side: the payer and chain from the
  credential's `source`, and the currency, recipient, amount, splits, `realm` and `id` of the challenge the payer
  signed for. `true` when the receipt succeeded and its logs from the currency (addresses compared without case,
  decoded with fixed event ABIs owned by the adapter, adjacent `Transfer` and `TransferWithMemo` of one transfer
  paired as mppx pairs them, logs that do not decode skipped) contain, each matched to a distinct log:
  - a `TransferWithMemo` from the payer to the recipient of the primary amount, whose memo has the MPP tag and
    version, the `realm` fingerprint and the challenge nonce;
  - one transfer from the payer per split, to its recipient, of its amount.

  `false` when the receipt does not carry them, or when the server's `reference` differs from the payer's own hash.
  Absent when no check was possible: no reader, no receipt, a reverted receipt, a `fundingCurrency` other than the
  challenge's currency (auto-swap and machine-token routes, where the log's `from` is not the payer), or values that
  do not validate. For push and unsponsored pull, the payer's own hash is the strong part of the check; for a
  sponsored pull, the memo is: it binds the transfer to the challenge with 56 bits, which a server choosing the
  challenge ids could search for a collision with an earlier payment of the same payer, recipient and amount. That is
  a known limit.
- **Response and request copies.** The adapter reads only the headers of a response copy and the URL of a request
  copy, and cancels the body of every copy it receives, in every event, so no copy keeps buffering a body. These are
  platform `Response`, `Request` and `Headers` objects that mppx created; an object that is not one (`instanceof`)
  is not read. Reading them through their native accessors is an explicit exception to ADR 0025 rule 2, which
  otherwise reads own data properties only, and the hostile-input rows cover it.
- **Later amendments, not v1.**
  - *Sessions:* a payment span per voucher (status for an authorized but unsettled payment to be decided), the
    deposit (`open`, `topUp`) never recorded as a settled payment (#436), and the settlement linked by
    `mpp.session.channel_id`, within a bounded number of links. Only after a real session run on Anvil.
  - *The `evm` method and subscriptions:* their own check and status model.
  - *The payee side* (an mppx server's `onPaymentSuccess`, `onPaymentFailed` and session settlement events) belongs
    to the update of ADR 0023 for resource servers, made protocol-neutral; this record stops at the client.
- **Docs text that changes with the implementation**, not before it: `blockchain.payment.protocol` gains the value
  `mpp`; the `blockchain.fee.payer` row says that `facilitator` is for a settlement another party sent; the payment
  paragraph and the parties table say that for MPP the payer is the transaction's `from` and pays its fee unless the
  server sponsors it; the bounds table lists the MPP payments waiting for an outcome. Each is an addition or a
  clarification under the change policy; no name is renamed or removed. This record's pull request only makes the
  `blockchain.tx.fee` row protocol-neutral, which is already true today.

## Open questions

- **Release line.** mppx is 0.x, and a raised peer floor after 1.0 is a major change (ADR 0027). Should
  `@hashspan/mpp` ship as 0.x, outside the four packages ADR 0027 freezes, until mppx reaches 1.0? The `@hashspan/*`
  linked group in `.changeset/config.json` would then need it left out, a release tooling change.
- **`mpp.challenge.id` on by default.** It joins the payer's trace to the server's logs and memo, and it is
  high-cardinality and server-chosen. On by default for spans (never metrics), or opt-in?
- **A protocol-neutral resource.** `mpp.resource` mirrors `x402.resource`. A neutral `blockchain.payment.resource`
  would need `x402.resource` recorded beside it for a minor release, a larger change for another record.
- **A timeout that knows a hash.** A push payment answered with a 4xx moved the money. Should a timed-out payment
  record the payer's own hash (a core option on `timeout`) so the span shows the transaction, or is the sibling send
  span enough?
- **Paid MCP tools.** Whether `mppx/mcp/client`'s `McpClient.wrap` emits these events is not verified; until a test
  shows it, paid MCP tools over MPP are a known gap.

## Consequences

- An agent's paid MPP calls on Tempo appear in its trace with what was paid, to whom, in which mode, whether it
  settled and, with a reader, the confirmation and whether the transaction carries this payment, without a send span
  the agent did not make (pull) or a second one (push).
- New attributes and the protocol value `mpp` enter the schema, and the core gains two optional `PaymentInput`
  fields: minor changes under the change policy and ADR 0014. A payment span's settlement fee is labelled
  `facilitator` only when another party sent the transaction.
- The adapter depends on the event API of mppx 0.13.5, its payload shapes, the credential and receipt encodings, the
  attribution memo layout and the TIP-20 event ABI, none of them frozen. It imports only mppx's public exports and
  pins the narrow range above; a weekly workflow, `.github/workflows/mppx-sdk.yml` like `x402-sdk.yml`, runs the tests
  against the newest mppx in range and the adapter's own tests against the oldest.
- Known limits, stated in the package README: sessions, subscriptions, `evm`, `stripe` and x402 over mppx are not
  traced; a 3xx, a 4xx or a final 402 after payment ends as `timeout`; a sponsored pull's hash and verification rest
  on the server's `reference` and the 56-bit memo binding; auto-swap and machine-token routes get no verdict; push
  from a JSON-RPC account (`sendCallsSync`) is linked only as far as its test shows; paid MCP tools until verified.
- **Tests the implementation pull request (T-0023) brings, written first:**
  - *Unit* (`packages/mpp/test/`): a real mppx client against a fake paid API, offline, for every row of the outcome
    table, the correlation by `challenge.id` (payloads are copies; repeated ids; a reused credential), mode
    detection, the hash derivation against mppx's own `PaymentOutcomeUnknownError.transactionHash`, a streamed paid
    response whose copy is cancelled while the caller reads the original to the end, and an older core.
  - *Hostile input* (`test/hostile-input.test.ts`, ADR 0025): the table applied to every observer, with hostile
    challenges (long or repeated ids, malformed amounts and addresses, 11 or more splits), credential strings,
    `Payment-Receipt` headers, error objects, response and request copies that are not platform objects, and the
    options and client.
  - *Anvil in Tempo mode* (`packages/mpp/test/*.int.test.ts`): `start-anvil.ts` gains a network option for
    `-n tempo`, and the test mines one block before the first charge (the fresh-chain `validAfter` check). Real
    charges through an mppx server in the same process, against the Anvil that `make tools` pins (1.8.4): push
    through a traced client (payment span linked to the send span, fee not `facilitator`), unsponsored and sponsored
    pull (confirm span, `sponsor` fee payer), splits, `verified` `true`, and `false` for a server that reports
    another transaction of the same payer, recipient and amount; a 4xx and a 5xx after payment; no public network.
  - *Fault proxy* (`test/rpc-faults.int.test.ts`): the reader behind the viem tests' fault proxy while a settlement is
    confirmed and checked, with the rows the x402 adapter has.
  - *The documented setup runs as written:* the README's quick start is a `#region readme` file that an
    `integrations/` test (or an Anvil test in the package) imports and runs against a local mppx server and Anvil in
    Tempo mode, redirecting its URLs as `integrations/test/mastra-agent.int.test.ts` does, and asserts its spans.
- The implementation also wires up the new package: the package table and commit scope (`mpp`) in AGENTS.md and
  CONTRIBUTING.md, an `AGENTS.md` and `CLAUDE.md` in the package, its API report, `check:packages`,
  `smoke:packages`, `scripts/publish-in-order.mjs`, a changeset, the docs text above, and a section in
  docs/integrations.md that supersedes the manual `watch()` setup of #438.
