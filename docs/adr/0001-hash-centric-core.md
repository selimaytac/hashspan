# 0001. Hash-centric core with thin capture adapters

- Status: accepted
- Date: 2026-09-26
- Amended: 2026-09-26: the core takes a normalised receipt from adapters instead of fetching it itself.
- Amended: 2026-10-03: the viem adapter is the EVM confirmation layer; its confirmation work gets modules of its own.

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

## Amendment (2026-10-03): the viem adapter is the EVM confirmation layer

The adapters are no longer equally thin. `@hashspan/viem` holds the confirmation work every EVM path needs: polling
for receipts off the call path, sealed receipts after a preconfirmation (ADR 0024), revert reason replay (ADR 0005),
the background limit (ADR 0018) and `flush()` (ADR 0010). `@hashspan/cdp` and `@hashspan/x402` confirm through its
`watch()`, so the packages form a layer: core, then viem, then the adapters built on both.

- **Decision:** keep that layer where it is. The core stays free of chain libraries (its only peer dependency is
  `@opentelemetry/api`), and the confirmation work needs viem for receipts, replay and ABI decoding; moving it into
  the core would take a reader abstraction and an ABI decoder with no second user. A separate confirmation package
  would be the same code with one more package to release, also with a single consumer today.
- **Inside the viem adapter,** the confirmation work lives in its own modules (`src/confirm/`), apart from the
  `withHashspan()` extension and each send path, behind a small internal interface (confirm a hash through a client,
  watch a hash). The extension wires them; nothing in them depends on the extension's closure.
- **Exit:** when a second consumer needs the confirmation work without the viem extension (for example an adapter
  for another EVM library), it moves into a package of its own; with the modules above, that is a move of files.
