# 0006. Error message privacy

- Status: accepted
- Date: 2026-09-27

## Context

ADR 0004 applies the address mode and the redaction hook to span attributes. Failures were recorded differently:
the error object was passed to `recordException` and its message became the span status description. Errors from
Ethereum client libraries are free text built for humans. viem, for example, appends the request arguments (sender,
recipient, calldata) to `message`, repeats them in `stack`, and its `shortMessage` can carry a node's message
(`insufficient funds ... address 0x...`) or a revert reason. So with `address: 'off'` a failed send still exported
the sender, and no redaction hook ever saw that text. Error messages can also contain RPC URLs, which may include
API keys.

## Decision

- The tracker never hands an error object to the OpenTelemetry SDK. It builds the `exception` event itself and runs
  the redaction hook on its attributes; the span status description is the recorded `exception.message`, if any.
- New option `errorMessages`:
  - `off` (default): `exception.type` only. `error.type` keeps identifying the failure class.
  - `sanitized`: plus `exception.message`, the first line of the message, with addresses written per address mode
    (`<address>` in `off` mode) and hex longer than 32 bytes (calldata, revert data) replaced by `<hex>`, capped at
    256 characters. Best effort: other free text is kept.
  - `raw`: plus the full message and `exception.stacktrace`, as thrown.
- Error names are free text as well: `error.type` and `exception.type` follow the address mode and pass through
  the redaction hook.
- If the redaction hook throws, only `exception.type` is kept on the event.
- Addresses inside `blockchain.tx.revert.reason` (custom error arguments) follow the address mode.
- Adapters log only error names through `diag`, never error objects from the instrumented library.
- The caller always receives the original error unchanged.

## Consequences

- Private by default at the cost of debuggability: the default trace says which error class failed, not why. Operators
  who trust their backend opt into `sanitized` or `raw`.
- `sanitized` cannot guarantee that free text is harmless; the redaction hook remains the last line of defence.
- Instrumentation-internal failures (for example a throwing redaction hook) are still logged through `diag` with
  their error object; they never contain the instrumented call's error.
