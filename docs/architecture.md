# Architecture

```mermaid
flowchart LR
  subgraph App["Agent application"]
    Tool["execute_tool span<br/>(AI SDK, Mastra, ...)"]
    Viem["viem client"]
    CDP["CDP / wallet API<br/>(planned)"]
    X402["x402 client<br/>(planned)"]
  end
  subgraph Lib["hashspan"]
    VA["@hashspan/viem<br/>capture adapter"]
    CA["@hashspan/cdp<br/>(planned)"]
    XA["@hashspan/x402<br/>(planned)"]
    Core["@hashspan/core<br/>tx lifecycle: send → confirm"]
  end
  Tool --> Viem --> VA
  CDP --> CA
  X402 --> XA
  VA & CA & XA -- "hash + metadata" --> Core
  Core -- "@opentelemetry/api" --> SDK["User's OTel SDK"] -- OTLP --> BE["Jaeger / Tempo / Langfuse / ..."]
  Core -. "receipt (read-only RPC)" .-> Chain[("EVM chain")]
```

| Component | Purpose | Path |
|---|---|---|
| core | Lifecycle tracker: `send`/`confirm` spans, links, fees, revert decoding, privacy modes | `packages/core` |
| viem adapter | Hooks `sendTransaction` / `writeContract` / `waitForTransactionReceipt` via `client.extend()`; optional RPC spans via transport wrapper | `packages/viem` |
| examples | Runnable agent integrations | `examples/` |
| lab | Local Jaeger (Docker) + project-local Anvil | `docker/`, `scripts/`, `Makefile` |

Design decisions: [docs/adr](adr/). Attribute schema: [docs/semconv.md](semconv.md).

## Principles

- **Library, not a service.** Only `@opentelemetry/api` is a peer dependency; users bring their own SDK and exporter.
- **Never on the critical path.** Instrumentation failures are swallowed and never change the result of a transaction call.
- **Read-only.** The library never signs or broadcasts transactions.
