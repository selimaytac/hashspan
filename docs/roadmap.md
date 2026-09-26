# Roadmap

## v0.1: EVM transactions through viem

- [x] **M0** Repository skeleton, CI, ADRs, draft semantic conventions
- [x] **M1** Core: `send` / `confirm` spans, span links, agent identity from Baggage, privacy modes
- [ ] **M2** viem adapter: `client.extend()` hooks + transport wrapper, Anvil integration tests
- [ ] **M3** Fees (`gasUsed × effectiveGasPrice` + OP-stack L1 fee), revert reason decoding, opt-in calldata decoding
- [ ] **M4** Example agent (Vercel AI SDK + viem) on Anvil and Base Sepolia, Jaeger quick start, README
- [ ] **M5** First release to npm with provenance, good first issues
  (verify that `changeset publish` via pnpm completes an OIDC trusted publish; otherwise publish with npm ≥ 11.5.1)

## v0.2: More send paths

- Coinbase CDP SDK adapter (REST send path)
- x402 adapter (payment signing → facilitator settlement)
- Metrics: transaction fee and confirmation latency histograms

## Later

- Upstream proposal for blockchain semantic conventions to OpenTelemetry
- ERC-4337 user operations, ethers v6 adapter, non-EVM chains
