# 0010. Flush pending tracing work before shutdown

- Status: accepted
- Date: 2026-09-29

## Context

Some tracing work outlives the call it traces, by design: background confirmations (ADR 0002), revert reason
replays after the caller's wait returned (ADR 0005) and calls recorded once their chain id is known (ADR 0009).
Scripts, CLI agents and serverless functions often shut the OpenTelemetry SDK down right after their last call.
Spans still open at that point are never exported, so the most interesting ones, such as a reverted transaction and
its reason, are the ones that go missing.

## Decision

- Each `withHashspan()` result tracks the work it started after a traced call returned.
- `flush({ timeoutMs })` on that result waits until the tracked work has finished, including work started while
  waiting, for at most `timeoutMs` (default 10 000 ms). It resolves `true` when everything finished and `false` on
  timeout; it never rejects.
- Applications call it before shutting the SDK down: `await hashspan.flush(); await provider.shutdown();`.
- The core tracker needs no flush: it starts no asynchronous work.

## Consequences

- Short-lived processes export complete traces without waiting for every background confirmation to time out.
- Work still pending after the timeout is dropped, as before; the result tells the caller that it happened.
- Long-running services do not need to call it.
