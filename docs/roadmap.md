# Roadmap

## v0.1: EVM transactions through viem

- [x] **M0** Repository skeleton, CI, ADRs, draft semantic conventions
- [x] **M1** Core: `send` / `confirm` spans, span links, agent identity from Baggage, privacy modes
- [x] **M2** viem adapter: `client.extend()` hooks for `sendTransaction`, `writeContract`,
  `waitForTransactionReceipt`, Anvil integration tests
- [ ] **M3** Confirmation coverage and richer transaction data
  - [x] Background confirmation in the viem adapter (`confirm: { mode: 'background' }`)
  - [x] Revert reason decoding for mined reverts
  - [ ] Opt-in recording of contract call arguments
- [ ] **M4** Example agent (Vercel AI SDK + viem) on Anvil and Base Sepolia, Jaeger quick start, README
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
