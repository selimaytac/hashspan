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
  carries a clone: the 402 response in `challenge.received` and `credential.created`, made whether or not anyone
  observes, and the paid response in `payment.response`, cloned only when a `payment.response` observer exists, since
  an unread clone of a stream buffers it. A clone whose body nobody reads or cancels keeps buffering what the original
  reads. One payload object goes to every observer of an event, `'*'` included, in the order they were registered.
  The `input` is passed on as it was given when it is a string, copied when it is a `URL` and cloned when it is a
  `Request`.
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
    the hash is the `keccak256` of the signed, canonically serialized transaction: mppx derives it so itself
    (`transactionHash` in `tempo/client/Charge.js`, not exported) for `PaymentOutcomeUnknownError`.
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
- **A 0.x release line.** `@hashspan/mpp` ships as 0.x, outside the four packages ADR 0027 freezes, until mppx
  reaches 1.0: following mppx's breaking minor lines needs a raised peer floor, a major change after 1.0. The
  implementation pull request takes it out of the `@hashspan/*` linked group in `.changeset/config.json`, so its
  version does not follow the 1.x packages.
- **Observers, not wrapping.** No method is replaced. Every observer catches its own failures and logs them via
  `diag`; the `challenge.received` observer never returns a value, so it never supplies a credential.
- **Scope of v1: Tempo `charge`, push and pull.** A challenge whose `method` is not `tempo` or whose `intent` is not
  `charge` is passed through untraced, with a `diag` message once per method and intent. A zero-amount challenge,
  answered with a signed proof, is left out at `challenge.received` and records nothing, failures included: no value
  moves.
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
    and `mpp.resource`. None becomes a metric attribute.
  - `mpp.challenge.id` is recorded by default, on spans only, validated against a short identifier pattern and
    bounded in length; a value that fails is not recorded. It joins the payer's trace to the server's logs and to
    the transfer's memo; it is server-chosen and high-cardinality, which is why it never reaches a metric.
  - `mpp.resource` has the meaning, modes and bound of `x402.resource` (origin by default; `paymentResource`; 512
    characters). A protocol-neutral resource attribute is left to a later record, since it would need
    `x402.resource` recorded beside it for a minor release.
- **Who sends the settlement: a core minor.** `PaymentInput` gains three optional fields (names proposed here,
  settled in the implementation's API report):
  - `sender: 'payer'`: the payer is the settlement transaction's `from`. The core then links the hash without the
    `facilitator` fee payer, so the fee sample carries `blockchain.fee.payer` `sponsor` when the receipt names
    another fee payer (a sponsored pull), and none when the payer paid.
  - `hash`: the settlement transaction's hash when the payer knows it at the start (push, unsponsored pull). The core
    records it as `blockchain.tx.hash` when the span starts, so every ending keeps it, a timeout included; links it
    as `link(hash)` does; and when the tracker has its own send span of that hash (push through a traced
    client), the payment span starts with a span link to it, visible to samplers, so the payment span and the
    payer's send and confirm spans point at each other.
  - `mpp`: MPP's details (method, intent, mode, challenge id, resource), beside `x402`.

  All three are additions (ADR 0014). The adapter detects them through a member added with them; with an older core
  it traces no MPP payment and logs a `diag` warning once, since its spans would label the payer's fee as a
  facilitator's.
- **One tracker for both adapters.** The link to the send span, and one confirm span per transaction, hold only when
  the payer's viem client and `@hashspan/mpp` share a tracker (the `tracker` option). With two trackers, a push
  payment gets two confirm spans and two fee samples for one transaction. The quick start shares one, and the
  documentation says why.
- **The payer's own hash wins.** For push, the hash is the credential's `payload.hash`. For an unsponsored pull, the
  adapter derives it from the signed transaction as mppx does: a `0x76` envelope, signed by the payer, without a fee
  payer marker, serialized canonically; when it cannot tell, the payment is handled as sponsored. A known hash is
  passed as `PaymentInput.hash` at `credential.created`, recorded as `blockchain.tx.hash`, and confirmed instead of a
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
  | no event: 3xx, a 4xx, a 402 after payment | error, `error.type` `timeout`, no status (ADR 0016), once the challenge's `expires` (bounded) or, without one, the client's default validity of 25 seconds, plus a grace period, has passed; the payer's own hash, when known, stays recorded (see below) |
  | too many payments open | the oldest ends as `timeout` |
  | `flush()` gives up | every payment still open with a span ends as `timeout`; a challenge without a credential is left to its deadline |

  At most 1000 payments are open per `withHashspan()` result, counting the start state of `challenge.received`, as
  for x402: the server decides how many challenges arrive. A later event for the same `challenge.id` and credential
  joins the open span; a repeated `challenge.received` keeps the first start time, and a second credential for an id
  that is open starts no second span (a hostile server repeating ids gets one span per id). The bounds are named
  constants listed in docs/semconv.md.
- **Confirmation only with a reader.** With a `reader` for the chain, the adapter calls `watch()` for every
  settlement or pending payment with a hash, as the x402 adapter does. A confirm span the tracker already has for
  that hash (a traced push on a shared tracker) is not duplicated (ADR 0007), and `watch()` still reads the receipt
  for the verification below; the push test shows both. The confirm span records block, gas, the fee in
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
  do not validate. For push and unsponsored pull, the payer's own hash is the strong part of the check. For a
  sponsored pull, whose hash only the server names, it is the payer's signed transaction: a receipt that carries the
  charge gives `true` only when the receipt's own transaction, read once through the reader (bounded, off the
  caller's path), was sent by the payer with the `nonceKey`, `nonce`, `validBefore` and `validAfter` of the signed
  transaction in the credential; otherwise there is no verdict (see the amendment below).
- **Response and request copies.** The adapter reads only the `Payment-Receipt` header of the paid response and the
  URL of the input (a string, a `URL` or a `Request`); it never reads a body. The copies of the 402 response and of
  the input, which mppx makes whether or not anyone observes, are left alone. The copy of the paid response exists
  only because the adapter registers a `payment.response` observer, and the payload is shared with the user's own
  observers, so the adapter releases it without taking it from them: after the event's observers have run (a later
  task), it cancels the copy's body only when nobody has started reading it, and ignores a rejected cancel. An
  observer of the user's that waits longer than that before it starts reading the copy finds it cancelled; leaving
  the copy uncancelled instead would buffer a long or streamed paid response for as long as the caller reads it.
  `Response`, `Request`, `URL` and `Headers` are platform objects, recognised with `instanceof` and read through
  their native accessors: an explicit exception to ADR 0025 rule 2, which otherwise reads own data properties only,
  covered by the hostile-input rows.
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

## Resolved questions (2026-10-18)

The choices that were open when this record was proposed, as decided above or here:

- **Release line:** `@hashspan/mpp` ships as 0.x, outside ADR 0027's freeze, until mppx reaches 1.0, and leaves the
  linked group (see *A 0.x release line*).
- **`mpp.challenge.id`:** on by default on spans, never on metrics, validated and bounded.
- **The resource:** `mpp.resource` for now; a protocol-neutral attribute is a later record.
- **A timeout that knows a hash:** a push payment answered with a 4xx moved the money, so a timed-out payment keeps
  the payer's own hash. The adapter passes it at the start as `PaymentInput.hash` (above), and the core records it as
  `blockchain.tx.hash` when the span starts, so `timeout()` needs no new option and ends the span with the hash and
  no `blockchain.payment.status`. That fits ADR 0016: the hash is a fact the payer holds, while the timeout stays the
  observer's outcome and claims nothing about the transaction. It is part of the additive `hash` field (ADR 0014);
  the sibling send span and, with a reader, the confirm span show what became of the transaction. A sponsored pull
  has no hash before a receipt, so its timeout records none.
- **The paid response's copy:** cancelled after the event's observers ran, only if nobody is reading it, as decided
  above.
- **Paid MCP tools:** the implementation pull request tests whether `mppx/mcp/client`'s `McpClient.wrap` fires these
  events. If it does not, paid MCP tools over MPP are a known limit, stated in the README.

## Proposed amendment: what the implementation found (2026-10-18)

The implementation pull request follows the decision above. Where the code showed more than this record says, it
does the following, proposed here for review before the record is accepted:

- **`payment.failed` is observed only on request.** mppx buffers the error body of a 5xx paid response (at most
  64 KiB and 2 seconds) only when a `payment.failed` observer exists: with one, a longer body comes back cut, with an
  `Mppx-Body-Truncated: true` header, and a body whose stream fails makes `fetch` reject where it returned the
  response before. Instrumentation must never alter the result of the user's call, so by default the adapter
  registers no `payment.failed` observer (and no `'*'` one, which counts as one). Then a 5xx after payment, or a paid
  request that threw, gets no event and ends as `timeout` once its deadline passed, keeping the payer's hash, and with
  a reader the adapter confirms that hash then; a failure before the credential records nothing. The option
  `observeFailures: true` registers the observer and gives the outcome table's `pending` and failure rows, with mppx's
  buffering as its documented trade-off. Tests compare a 5xx body over 64 KiB and a failing body stream byte for byte
  with a run without hashspan.
- **The manual APIs fire no outcome event.** `preparePayment`, `prepareRequest` and `createCredential` emit
  `challenge.received` and `credential.created`, never `payment.response` or `payment.failed`: such a payment starts
  its span and ends as `timeout`. A known limit.
- **Further bounds**, listed in docs/semconv.md: a challenge id longer than 1024 characters is not followed (the
  payment is not traced); a credential longer than 65 536 characters and a `Payment-Receipt` header longer than 4096
  are not decoded (no mode or hash, and `_OTHER`). A challenge that gets no credential before its deadline, or that is
  evicted by the 1000-payment bound, records nothing.
- **The chain without a source.** A credential without a valid `source` gives the chain from the challenge's
  `methodDetails.chainId` and no payer, so no verdict; a payment that fails before its credential is recorded the
  same way. Without either chain id, nothing is recorded.
- **Names settled in the API report:** `PaymentInput.sender` is `'facilitator' | 'payer'` (default `facilitator`;
  any other value is read as `facilitator`), and the member that tells an adapter the core reads the three fields is
  `TxTracker.paymentSenders`, the frozen list `['facilitator', 'payer']`. `mpp.challenge.id` is recorded when it has
  1 to 128 characters of RFC 3986's unreserved set, which a base64url HMAC id uses, and, in `hashed` and `off`
  address mode, no run of 40 hex characters: a server could choose the payer's address as an id.
- **A cancelled copy is disturbed.** An observer that starts reading the paid response's copy after it was released
  gets a rejected read (`TypeError`), as for a body read before.
- **Push from a wallet account** (`sendCallsSync`) was checked on Anvil, where viem falls back to
  `eth_sendTransaction` for a single call: the payment span links to the call batch's send span, and the
  transaction's confirm span to the same send span.
- **A sponsored pull's verdict rests on the payer's signed transaction.** For a sponsored pull the hash comes from
  the server, so `true` also needs the mined transaction to be the payer's signed one. mppx signs every pull with
  Tempo's expiring nonce (`nonceKey` the maximum, `nonce` 0) and a validity window of its own (`validAfter`, `validBefore`).
  The adapter keeps these four fields from the credential's signed transaction (the `0x78` envelope mppx sends the
  fee payer, or a `0x76` one with a fee payer marker), and once the receipt carries the charge it reads the
  receipt's own transaction with one `eth_getTransactionByHash` request, as the x402 adapter does for Permit2 (at
  most 10 seconds, the timer unref'd). `true` needs that transaction's `from` to be the payer and its four fields to
  equal the signed ones. A transaction that cannot be read in time, a field that is missing or not a canonical
  quantity, or one that differs gives no verdict rather than `false`: the receipt may still carry this payment's
  transfer. A credential whose transaction does not decode gives no verdict without a read. Push and unsponsored
  pull are unchanged. Unit tests cover each field and a reported transaction that is not the payer's signed one; the
  Anvil test checks the same with real sponsored charges.
- **`flush()` waits only for payments with a span.** A challenge that never got a credential (the client's policy
  or spending limit refused it, or signing failed) has no span to end. `flush()` neither waits for it nor ends it:
  it stays open until its deadline, so a credential created later is still traced, and it records nothing when
  dropped.

## Open questions

- **Sessions:** the status of an authorized but unsettled voucher payment (a new value such as `authorized`, or none),
  and how a settlement links to its vouchers within a bound, for the sessions amendment.

## Consequences

- An agent's paid MPP calls on Tempo appear in its trace with what was paid, to whom, in which mode, whether it
  settled and, with a reader, the confirmation and whether the transaction carries this payment, without a send span
  the agent did not make (pull) or a second one (push).
- New attributes and the protocol value `mpp` enter the schema, and the core gains three optional `PaymentInput`
  fields: minor changes under the change policy and ADR 0014. A payment span's settlement fee is labelled
  `facilitator` only when another party sent the transaction.
- The adapter depends on the event API of mppx 0.13.5, its payload shapes, the credential and receipt encodings, the
  attribution memo layout and the TIP-20 event ABI, none of them frozen. It imports only mppx's public exports and
  pins the narrow range above; a weekly workflow, `.github/workflows/mppx-sdk.yml` like `x402-sdk.yml`, runs the tests
  against the newest mppx in range and the adapter's own tests against the oldest.
- Known limits, stated in the package README: sessions, subscriptions, `evm`, `stripe` and x402 over mppx are not
  traced; a 3xx, a 4xx or a final 402 after payment ends as `timeout`; a sponsored pull's hash rests on the
  server's `reference`, and its verdict needs one more read of the mined transaction; auto-swap and machine-token routes get no verdict; push
  from a JSON-RPC account (`sendCallsSync`) is linked only as far as its test shows; paid MCP tools, if their test
  shows they fire no events.
- **Tests the implementation pull request brings, written first:**
  - *Unit* (`packages/mpp/test/`): a real mppx client against a fake paid API, offline, for every row of the outcome
    table, the correlation by `challenge.id` (payloads are copies; repeated ids; a reused credential), mode
    detection, zero-amount challenges, the hash derivation against mppx's own
    `PaymentOutcomeUnknownError.transactionHash`, a streamed paid response whose copy is released while the caller
    reads the original to the end, an observer of the user's registered after hashspan's that reads the paid
    response's copy, string, `URL` and `Request` inputs, a timed-out push that keeps its hash, a paid MCP tool
    through `McpClient.wrap`, and an older core.
  - *Hostile input* (`test/hostile-input.test.ts`, ADR 0025): the table applied to every observer, with hostile
    challenges (long or repeated ids, malformed amounts and addresses, 11 or more splits), credential strings,
    `Payment-Receipt` headers, error objects, response and request copies that are not platform objects, and the
    options and client.
  - *Anvil in Tempo mode* (`packages/mpp/test/*.int.test.ts`): Anvil started with `start-anvil.ts`'s
    `network: 'tempo'` option (added with the Tempo fee test of #442), and the test mines one block before the first charge (the fresh-chain `validAfter` check). Real
    charges through an mppx server in the same process, against the Anvil that `make tools` pins (1.8.4): push
    through a traced client on a shared tracker (payment span linked to the send span, one confirm span, a verdict,
    fee not `facilitator`) and on a separate tracker (what the documentation says it records), unsponsored and sponsored
    pull (confirm span, `sponsor` fee payer), splits, `verified` `true`, and `false` for a server that reports
    another transaction of the same payer, recipient and amount; a 4xx and a 5xx after payment; no public network.
  - *Fault proxy* (`test/rpc-faults.int.test.ts`): the reader behind the viem tests' fault proxy while a settlement is
    confirmed and checked, with the rows the x402 adapter has.
  - *The documented setup runs as written:* the README's quick start is a `#region readme` file that an
    `integrations/` test (or an Anvil test in the package) imports and runs against a local mppx server and Anvil in
    Tempo mode, redirecting its URLs as `integrations/test/mastra-agent.int.test.ts` does, and asserts its spans.
- The implementation also wires up the new package: the package table and commit scope (`mpp`) in AGENTS.md and
  CONTRIBUTING.md, an `AGENTS.md` and `CLAUDE.md` in the package, its API report, `check:packages`,
  `smoke:packages`, `scripts/publish-in-order.mjs`, its removal from the linked group, a changeset, the docs text above, and a section in
  docs/integrations.md that supersedes the manual `watch()` setup of #438.
