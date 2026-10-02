# 0023. Payments received by an x402 resource server

- Status: proposed
- Date: 2026-10-03

## Context

`@hashspan/x402` traces the paying side (ADR 0013): each payment an agent makes is a `payment` span. The other side,
the resource server that is paid, sees every payment it accepts, and nothing traces it: the x402 TypeScript packages
have no tracing, and searches of npm and GitHub found no OpenTelemetry instrumentation for x402 servers or
facilitators.

What the x402 SDK (`@x402/core` 2.13 to 2.28, the range `@hashspan/x402` supports) provides:

- **Who settles.** A resource server verifies and settles each payment through a facilitator. The SDK's default is
  a hosted one (`@x402/core` uses `https://x402.org/facilitator` when given no URL), and Coinbase's seller guide uses
  its hosted CDP facilitator. A hosted facilitator runs none of the seller's code; a facilitator runs hashspan only
  when the seller operates it.
- **Hooks on `x402ResourceServer`** (`@x402/core/server`, checked in 2.13.0 and 2.28.0): `onBeforeVerify`,
  `onAfterVerify`, `onVerifyFailure`, `onBeforeSettle`, `onAfterSettle`, `onSettleFailure` and
  `onVerifiedPaymentCanceled`. They are awaited in registration order, and a hook that throws is caught by the SDK
  and logged with `console.warn`, so it cannot fail the request.
  - `onAfterVerify` runs with the facilitator's result whether the payment is valid or not; `onVerifyFailure` runs
    only when verification throws.
  - A settle result with `success: false` reaches `onAfterSettle` in 2.13 and `onSettleFailure` in 2.28, which also
    retries a `settlement_pending` settle once. A settle that throws without a facilitator report (a network error
    to the facilitator, an exception other than a settle error) reaches `onSettleFailure` with only the error.
  - A hook that aborts in `onBeforeVerify` or `onBeforeSettle` ends the payment: hooks registered after it do not
    run, and no later hook runs. A `skip` returned there instead hands its result to the after-hooks, as a real
    verification or settlement would. An `onAfterVerify` abort (2.28) cancels the verified payment, reported through
    `onVerifiedPaymentCanceled` (`after_verify_aborted`); its `skipHandler` skips the route handler and settles at
    once, through the same settle hooks.
- **One payment across hooks.** The `paymentPayload` object is the same reference from verification to settlement;
  the requirements object is too, except when a settlement override amount replaces it with a copy. Hook contexts
  carry `transportContext`: for HTTP, the request, whose `routePattern` (the matched route, such as
  `/api/weather/:city`) is set at verification. A request with no matching payment requirements, or whose extension
  data fails validation, is answered before any resource server hook runs.
- **Timing.** In the default `authorization` flow, the server verifies before its handler runs, holds the handler's
  response, and settles after it; a handler status of 400 or more cancels the payment without settling, which
  `onVerifiedPaymentCanceled` reports (the Express middleware calls it from 2.13 on). 2.28 adds flows, named in
  `requirements.extra.paymentFlow` or defaulted by the scheme: `upfront` settles before the handler, and its
  verification returns without running the verify hooks; `escrow` settles twice, before and after the handler, with
  the settle hooks once per `phase`. The cancellation of an `upfront` payment can be reported after its settlement
  succeeded, since the cancel lists the phases already settled.
- **Reaching the server.** The Express, Hono and Next.js middlewares accept an `x402ResourceServer` or an
  `x402HTTPResourceServer` (whose `server` is the former) built by the user; their `...FromConfig` variants build one
  internally that cannot be reached.
- **What the server learns.** From the requirements: network (CAIP-2), scheme, asset, amount and `payTo`; from the
  facilitator: `isValid` and `invalidReason`, then `success`, `errorReason`, `payer`, `transaction`, `network` and,
  for `upto`, the settled `amount`. Between the server and a remote facilitator, the SDK calls `/verify` and
  `/settle` with the global `fetch`.
- **Facilitators.** `x402Facilitator` has six hooks, the resource server's without `onVerifiedPaymentCanceled`, but
  a hook that throws there breaks the response, even after the settlement transaction was broadcast. Its EVM schemes
  send the settlement through the viem client the operator passes to `toFacilitatorEvmSigner` (`writeContract`,
  `sendTransaction`, `waitForTransactionReceipt`). With that client extended with `@hashspan/viem`'s
  `withHashspan()`, a run of the SDK facilitator on Anvil recorded the settlement as a `send` span
  (`transferWithAuthorization`, from the facilitator's account) and a `confirm` span.
- **The core today.** `startPayment` records every payment span with kind CLIENT, and `PaymentInput` has no field
  for a role or a kind.

## Decision

- **A resource server adapter first.** `withHashspanServer(server, options)` in `@hashspan/x402` (a new export,
  minor) takes an `x402ResourceServer` or an `x402HTTPResourceServer` and registers hooks on the resource server, as
  `withHashspan()` does on the client. Its options are those of the client's `withHashspan()`: the tracker options,
  `reader`, `confirmTimeoutMs` and `decodeRevertReason` (default `false`, for the same reason as on the client).
  Hooks never return a value and catch their own failures, logging through `diag`; a second call on the same server
  returns the first handle. Servers built inside a middleware's `...FromConfig` cannot be traced; the documentation
  says to build the server and pass it, and to register hashspan before hooks of its own, as for the client.
- **Core support.** `PaymentInput` gains an optional `role`, `payer` (the default) or `payee`. A `payee` payment span
  has kind INTERNAL and records `blockchain.payment.role` `payee`; a payer span records `payer`. This is a new member
  of a core input (ADR 0014), a minor change. The server adapter detects whether the tracker's core knows the role,
  through a member added with it, as ADR 0014 describes; with an older core it traces no received payment and logs
  a `diag` warning once, since its spans would be CLIENT spans without a role, indistinguishable from payer spans.
- **One `payment {chainId}` span per payment received.** Its start time and parent context are captured in
  `onBeforeVerify` (the HTTP server span when the server has HTTP instrumentation); the span itself is created by the
  first later hook that runs for the payment (`onAfterVerify`, `onVerifyFailure`, or `onBeforeSettle` in a flow
  without verify hooks), as ADR 0013 does on the payer's side, so a payment that a hook registered after hashspan's
  aborts before verification leaves no span. Its kind is INTERNAL: the HTTP
  instrumentation owns the SERVER span, and verification and settlement are steps of handling that request. The span
  ends with the outcome of the payment:
  - settled, pending or failed: from the settle result, as on the payer's side (`blockchain.payment.status`
    `settled`, `pending` for `settlement_pending`, `failed` with the facilitator's `errorReason` as `error.type`);
  - settlement threw without a facilitator report: error status, `error.type` from the error, no
    `blockchain.payment.status`;
  - invalid: verification returned `isValid: false`; error status, `error.type` is the facilitator's
    `invalidReason`;
  - verification failed (threw): error status, `error.type` from the error, as for a failed send;
  - canceled before settlement (the handler failed, or an `onAfterVerify` hook aborted): error status, `error.type`
    `payment_canceled`; a cancellation reported after the span ended with a settlement (`upfront`) is ignored, since
    the payment was settled;
  - outcome never learned: no settle or cancel before the requirements' `maxTimeoutSeconds` plus a grace period,
    when too many payments are open, or when `flush()` gives up: error status, `error.type` `timeout`, as on the
    payer's side. This includes a payment that a hook registered after hashspan's aborts in `onBeforeSettle`, since
    the SDK calls no hook after the abort.

  `error.type` from the facilitator follows ADR 0013's rule: a short identifier, else `_OTHER`. Verification and
  settlement are recorded as span events, `x402.verify` when the verification result arrives and `x402.settle` when
  settlement starts, so the time each took is visible without more spans; an `upfront` payment has no verification
  event, since its verify hooks do not run. A 402 challenge, which unauthenticated callers can request at any rate,
  records nothing.
- **The payer's and the payee's spans share their name and attributes.** The new attribute
  `blockchain.payment.role` tells them apart. The payee span records, as the payer span does:
  `blockchain.payment.protocol` `x402`, the payer (from the signed payload's authorization, which the server holds
  itself, else the facilitator's result, as ADR 0013 prefers what a party holds over what another reports), the
  recipient (`payTo`), asset and amount of the requirements, `blockchain.payment.settled_amount` and
  `blockchain.tx.hash` from the settle result, `x402.scheme` and `x402.resource`. Status and settled amount are the
  facilitator's report.
- **Privacy.** Addresses follow the tracker's address mode (ADR 0004), which applies to the payer's address here as
  everywhere; the server operator records a third party's address, which the documentation states, with `hashed`
  and `off` as the alternatives.
- **The resource on the payee side.** `x402.resource` holds the route pattern (`/api/weather/:city`) the SDK matched:
  it names the resource without request data. docs/semconv.md states this meaning for payee spans, next to the
  payer's origin and path modes. `paymentResource` `origin` (the default) and `path` both record the route pattern
  on payee spans, and `off` records nothing. Without a route pattern (a transport other than HTTP, or a server called
  directly), nothing is recorded: the client-supplied resource URL can carry request data. The concrete URL, its
  query string and fragment are never recorded.
- **Checking the settlement.** With a `reader` for the chain, the adapter confirms the settlement transaction with
  `watch()`, which links the confirm span to the payment span, and records `blockchain.payment.verified` by the
  checks of ADR 0017 with the requirements and the payload as inputs: whether the facilitator's transaction carries
  this payment. Without a reader, only the payment span is recorded. This part may ship after the payment span.
- **Flows.** The `authorization` flow is traced on every supported SDK version, and the `upfront` flow of 2.28 (one
  settle, before the handler) too. An `escrow` payment (two settles), recognised in `onBeforeVerify` by
  `requirements.extra.paymentFlow`, is passed through untraced with a `diag` message once, until a later decision; a
  scheme whose default flow is `escrow` and that does not name it is traced as `upfront` from its first settle, and
  its second settle is ignored. Non-EVM networks and x402 v1 are not traced, as on the payer's side.
- **Trace context between parties.** hashspan adds no headers. With the user's HTTP instrumentation on both sides,
  the payer's request and the server's spans share a trace; the server's calls to a remote facilitator are HTTP
  client spans of that instrumentation. The transaction hash also connects the payer's and the payee's payment
  spans in any backend that can search attributes.
- **Facilitators, later.** A facilitator run by the operator is documented, not wrapped, in this step: extending the
  viem client given to `toFacilitatorEvmSigner` with `withHashspan()` (after `publicActions`) records each settlement
  as `send` and `confirm` (see Context); the implementation adds this as a test. Hook-based facilitator spans need
  every hook guarded against the facilitator breaking its response, and are a separate decision.

## Open questions

These choices are written into the decision above but are not yet confirmed; they are settled before this record is
accepted:

- the route pattern as the default `x402.resource` on payee spans;
- the payer's address from the signed payload first, then the facilitator's result;
- the event names `x402.verify` and `x402.settle`;
- payer spans recording `blockchain.payment.role` `payer`, a change to released spans;
- `escrow` payments passed through untraced.

## Consequences

- `blockchain.payment.role` is a new attribute, and payment spans gain a second producer, under the change policy of
  docs/semconv.md; the payer's spans gain `role` `payer`, a minor change. The payment span's kind is CLIENT for the
  payer and INTERNAL for the payee.
- Sellers using a hosted facilitator see their side of every payment and, with a reader, whether its settlement
  transaction carries the payment, but nothing of the facilitator's own work.
- Known gaps: servers built by `...FromConfig` middleware helpers; `escrow` payments; payments aborted in
  `onBeforeSettle` by a hook registered after hashspan's (recorded as `timeout`); requests with no matching payment
  requirements or with failed extension validation, which reach no resource server hook and leave no span (ADR 0013
  lists its equivalent on the payer's side).
- Tests run offline with the SDK's resource server and facilitator on Anvil, as
  `packages/x402/test/settlement.int.test.ts` does for the payer: settled, invalid, handler failure, failed and
  pending settlements, a settle that throws, an `upfront` payment on 2.28, both ends of the SDK range (the weekly x402
  workflow), an older core, a facilitator client extended with `withHashspan()`, and a payer and a server under HTTP
  instrumentation sharing a trace.
