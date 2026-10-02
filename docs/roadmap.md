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

## Next: more send paths

Not tied to a version: an item ships with the first release after its pull request is merged.

- [x] viem transport wrapper: JSON-RPC spans ([ADR 0019](adr/0019-json-rpc-spans.md))
- [ ] viem `deployContract`, `sendRawTransaction`
- [x] viem EIP-5792 `sendCalls` ([ADR 0022](adr/0022-call-batches.md))
- [ ] CDP smart account user operations (ERC-4337)
- [x] Metrics: transaction fee and confirmation latency histograms ([ADR 0020](adr/0020-metrics.md))

## Toward 1.0: a stable API

- [x] Trackers and handles produced by the core only; handle methods take an options object
  ([ADR 0014](adr/0014-core-api-boundary.md))
- [x] The send span is the active span while the transaction is sent
  ([ADR 0015](adr/0015-send-span-as-active-context.md))
- [x] `blockchain.tx.status` from chain data only: `timeout` deprecated, then no longer recorded
  ([ADR 0016](adr/0016-timeout-is-an-observer-outcome.md))

## Later

- Upstream proposal for blockchain semantic conventions to OpenTelemetry
- ERC-4337 user operations, ethers v6 adapter, non-EVM chains
