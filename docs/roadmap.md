# Roadmap

## v0.1: EVM transactions through viem

- [x] **M0** Repository skeleton, CI, ADRs, draft semantic conventions
- [x] **M1** Core: `send` / `confirm` spans, span links, agent identity from Baggage, privacy modes
- [x] **M2** viem adapter: `client.extend()` hooks for `sendTransaction`, `writeContract`,
  `waitForTransactionReceipt`, Anvil integration tests
- [x] **M3** Confirmation coverage and richer transaction data
  - [x] Background confirmation in the viem adapter (`confirm: { mode: 'background' }`)
  - [x] One confirm span per transaction, shared by every wait ([ADR 0007](adr/0007-confirmation-ownership.md))
  - [x] Receipts of replaced transactions attributed to the mined one ([ADR 0008](adr/0008-replaced-transactions.md))
  - [x] Revert reason decoding for mined reverts ([ADR 0005](adr/0005-revert-reason-replay.md))
  - [x] Error messages kept out of spans by default ([ADR 0006](adr/0006-error-privacy.md))
  - [x] Chain id resolution off the call path ([ADR 0009](adr/0009-telemetry-off-the-call-path.md))
  - [x] Opt-in recording of contract call arguments
  - [x] `flush()` before shutting down ([ADR 0010](adr/0010-flush-before-shutdown.md))
- [x] **M4** Example agent, Jaeger quick start, README
  - [x] AI SDK agent example on Anvil, runnable without an API key, tested in CI (`make demo`)
  - [x] Trace screenshot in the README
  - [x] Base Sepolia run of the example (`make demo-base-sepolia`, see the [example](../examples/ai-sdk-agent/README.md#run-it-on-base-sepolia))
- [x] **M5** First release to npm with provenance, good first issues
  - [x] Packages checked with publint and arethetypeswrong in CI; release process in [docs/releasing.md](releasing.md)
  - [x] One-time setup (placeholders, trusted publishers) and the first release: 0.1.0, published with provenance
  - [x] Good first issues ([open issues](https://github.com/selimaytac/hashspan/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22))

## v0.3: Transactions sent by wallet APIs

- [x] viem `watch()`: confirm transactions sent outside the extended clients, such as by a wallet API
- [x] Coinbase CDP SDK adapter for server accounts (REST send path, [ADR 0012](adr/0012-cdp-adapter.md)), tested
  weekly against the newest SDK in its peer range

## v0.4: Payments over x402

- [x] x402 adapter (payment signing → facilitator settlement, [ADR 0013](adr/0013-x402-payments.md))

## v0.5: Settled amounts

- [x] `blockchain.payment.settled_amount`: what an x402 `upto` payment actually charged
  ([semantic conventions](semconv.md#attributes))
- [x] `timeout` no longer recorded as `blockchain.tx.status` (see [1.0](#10-a-stable-api))

## v0.6: Verified x402 payments

- [x] `blockchain.payment.verified` for `exact` EIP-3009 payments, checked against the settlement receipt with a
  reader ([ADR 0017](adr/0017-x402-payment-verification.md)); viem `watch()` takes `onReceipt`

## v0.7: Metrics, JSON-RPC spans, Permit2

- [x] Send, confirmation and fee histograms from the tracker ([ADR 0020](adr/0020-metrics.md))
- [x] viem transport wrapper: JSON-RPC spans ([ADR 0019](adr/0019-json-rpc-spans.md))
- [x] A limit on background confirmations ([ADR 0018](adr/0018-background-confirmation-limit.md))
- [x] Payment verification for Permit2 `exact` and `upto`
  ([ADR 0017 amendment](adr/0017-x402-payment-verification.md#amendment-permit2-and-upto))

## v0.8: Smart accounts

- [x] User operations of smart accounts (ERC-4337): viem bundler clients and CDP smart accounts
  ([ADR 0021](adr/0021-user-operations.md))
- [x] Fees from the sealed receipt, not a flashblocks preconfirmation, in viem and, in 0.8.1, CDP
  ([ADR 0024](adr/0024-sealed-receipt-fees.md))
- [x] Permit2 payments verified by their nonce
  ([ADR 0017 amendment](adr/0017-x402-payment-verification.md#amendment-the-permit2-nonce))
- [x] viem 0.8.2: revert reasons of transactions that call a contract created in the same block
  ([ADR 0005 amendment](adr/0005-revert-reason-replay.md#amendment-2026-10-03-a-contract-created-in-the-same-block))

## v0.9: Maturation

Tracked in the [0.9 milestone](https://github.com/selimaytac/hashspan/milestone/1).

- [x] viem EIP-5792 `sendCalls` ([ADR 0022](adr/0022-call-batches.md))
- [x] EIP-7702 authorizations on the send span of a type 4 transaction (#165)
- [x] Addresses recorded in one form, lower case, on every span ([ADR 0004](adr/0004-privacy-defaults.md))
- [x] Privacy fixes: hex values cut whole, URLs in sanitized messages cut to their origin, `watch()` checks the chain
  of a client without one, at most 64 authorizations read (#252 to #255)
- [x] Every documented integration runs in CI on Anvil ([integrations](integrations.md))
- [x] Published packages checked on every supported Node.js version (#34)
- [x] User operations tested through a real bundler (#206)
- [x] Mutation testing of fee and receipt matching (#207)
- [x] A Grafana dashboard for the send, confirmation and fee histograms in the local lab (#163,
  [backends](backends.md#grafana-dashboard-for-the-metrics))
- [x] cdp 0.9.1: network names of `Object.prototype` members and the keys of wrapped objects left alone (#259)

## 1.0: a stable API

Released in 1.0.0, once every criterion below was met.

- [x] Trackers and handles produced by the core only; handle methods take an options object
  ([ADR 0014](adr/0014-core-api-boundary.md))
- [x] The send span is the active span while the transaction is sent
  ([ADR 0015](adr/0015-send-span-as-active-context.md))
- [x] `blockchain.tx.status` from chain data only: `timeout` deprecated, then no longer recorded
  ([ADR 0016](adr/0016-timeout-is-an-observer-outcome.md))

Exit criteria:

- [x] Every public export and `withHashspan` option of the four packages is documented, and the export pins in each
  package's `test/exports.test.ts` match the docs: the API report of each package (`packages/*/etc/*.api.md`) lists
  every export, and `pnpm api:check` fails in CI on a stale report or an undocumented export (#362)
- [x] No open P0 or P1 issue; the known limits of each adapter are stated in its README (a `Known limits` section in
  each package README)
- [x] Span and attribute names reviewed once as a whole, for consistent naming across transaction, user operation,
  payment and call batch spans; renames done through deprecation: `blockchain.system.name` is recorded next to
  `blockchain.system` in 0.11 and 0.12 and replaces it in 1.0 (#365), the other names are kept and the reasons
  documented (#364)
- [x] Each adapter validated in at least one real integration, with its findings closed: every setup in
  [integrations](integrations.md) runs in CI, and each adapter sent real transactions and payments on Base Sepolia
- [x] A first run needs nothing beyond the docs: the [quick start](../README.md#quick-start) `agent.ts`, run as
  written, gives the trace the README describes, against Anvil in CI (`packages/viem/test/quick-start.int.test.ts`);
  from an empty project with the published packages, the docs lead to a send and a confirm span once with a viem
  client and once with a setup from [integrations](integrations.md) (#242)
- [x] The published packages smoke-tested on every supported Node.js version (#34)
- [x] A stated policy for what 1.0 freezes (the public API) and what stays `development` (the semantic conventions,
  under their [change policy](semconv.md#change-policy)): [ADR 0027](adr/0027-what-1-0-freezes.md)

## Candidates

Not scheduled: each needs a user or an integration that asks for it.

- viem `deployContract` (#36)
- x402 resource servers and facilitators (#164; ADR 0023 proposed in #199)
- ethers v6 adapter
- Non-EVM chains
- Upstream proposal for blockchain semantic conventions to OpenTelemetry
