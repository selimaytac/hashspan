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
- [ ] **M4** Example agent, Jaeger quick start, README
  - [x] AI SDK agent example on Anvil, runnable without an API key, tested in CI (`make demo`)
  - [x] Trace screenshot in the README
  - [ ] Base Sepolia run of the example
- [ ] **M5** First release to npm with provenance, good first issues
  (verify that `changeset publish` via pnpm completes an OIDC trusted publish; otherwise publish with npm ≥ 11.5.1;
  `@hashspan/*` packages are versioned together, so don't release before the viem adapter is functional)

## v0.2: More send paths

- viem transport wrapper: JSON-RPC spans
- viem `deployContract`, `sendRawTransaction`, `sendCalls`
- Coinbase CDP SDK adapter (REST send path)
- x402 adapter (payment signing → facilitator settlement)
- Metrics: transaction fee and confirmation latency histograms

## Later

- Upstream proposal for blockchain semantic conventions to OpenTelemetry
- ERC-4337 user operations, ethers v6 adapter, non-EVM chains
