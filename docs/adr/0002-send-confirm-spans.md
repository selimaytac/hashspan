# 0002. Separate `send` and `confirm` spans connected by a span link

- Status: accepted
- Date: 2026-09-26

## Context

`sendTransaction` returns a hash immediately; status and fees exist only after the receipt, which can take from
milliseconds (Anvil) to minutes (congested L1). Agents often do not wait for receipts at all.

## Decision

- A `send` span (kind CLIENT) is a child of the active context (typically the framework's `execute_tool` span) and
  ends when the hash is returned or the send fails.
- A `confirm` span covers receipt retrieval. It is a child of whichever context waits for the receipt (or of the
  `send` span's parent when confirmation runs in the background) and carries a **span link** to the `send` span.
- The core keeps a bounded, TTL-evicted map from `(chainId, hash)` to the `send` span context to create the link.

This mirrors the OpenTelemetry messaging conventions, where producer and consumer spans are correlated through
links rather than a single long-lived span.

## Consequences

- No span is held open across long or unbounded waits; nothing leaks when a process exits early.
- Backends show two spans per transaction; the link lets UIs jump between them.
- If the process exits before confirmation, the trace contains only the `send` span. This is accepted.
