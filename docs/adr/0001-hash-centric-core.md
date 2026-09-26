# 0001. Hash-centric core with thin capture adapters

- Status: accepted
- Date: 2026-09-26

## Context

AI agents send EVM transactions through very different paths:

- a viem client with a user-controlled transport (GOAT, AgentKit `ViemWalletProvider`, Turnkey/Privy accounts, hand-written tools),
- a vendor REST API that signs **and** broadcasts (Coinbase CDP SDK, Privy wallet API, Crossmint, thirdweb Engine),
- payment protocols where the client only signs and a facilitator broadcasts (x402).

A transport-level instrumentation sees only the first path. The only data every path eventually yields is the
transaction hash and the chain id.

## Decision

Split the library in two layers:

1. **Core (`@hashspan/core`)** owns the transaction lifecycle. Given a tx hash, chain id, the parent context
   and optional metadata, it emits the `send` span and later the `confirm` span (receipt, status, fees, revert
   reason). It never signs, broadcasts or performs network calls: adapters fetch receipts with a read-only client
   and pass a normalised `ReceiptLike`, which keeps the core independent of any chain library.
2. **Capture adapters** (`@hashspan/viem` first; CDP and x402 later) observe the send path, collect metadata
   (from, to, value, function) and hand the hash to the core.

## Consequences

- New send paths are new adapters, not rewrites.
- Confirmation does not depend on observing the user's client, so it works even when the framework polls receipts
  through its own client (e.g. AgentKit).
- Adapters for send paths without a user-visible client (REST wallet APIs) need their own read-only client to
  fetch receipts by hash.
