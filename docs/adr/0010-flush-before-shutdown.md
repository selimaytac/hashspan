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
- Its deadline timer is referenced, unlike the library's other timers: pending work may hold no timer or socket of
  its own (a provider request that never answers), and the process must not exit while `flush()` is awaited.
- On timeout, every confirm handle this `withHashspan()` result is still waiting on is ended, so its span is
  exported with the rest: with the receipt (without a revert reason) if the receipt is known and only the revert
  reason replay is pending, otherwise with status `timeout`. A result that arrives later is ignored, and the ended
  work no longer counts as pending, so a later `flush()` does not wait for it again.
- Applications call it before shutting the SDK down: `await hashspan.flush(); await provider.shutdown();`.
- The core tracker needs no flush: it starts no asynchronous work.

## Consequences

- Short-lived processes export complete traces without waiting for every background confirmation to time out.
- Nothing is silently dropped: confirmations `flush()` could not wait for are exported, and the result tells the
  caller that it happened. Calls whose chain id is still unknown have no span yet and are not covered by that
  flush; they are recorded later if the process lives on.
- Handles started by other code on a shared custom `tracker` are not ended; a shared confirm span then stays open
  until they end.
- The underlying work is not cancelled: a background confirmation keeps polling until its own `timeoutMs`, which
  can keep a process alive after `flush()` resolved `false`. Short-lived processes should use a short background
  timeout.
- A timed-out flush also ends the spans of the application's own receipt waits that are still running; a receipt
  they return later is not recorded. `flush()` is therefore meant for shutdown only.
- Long-running services do not need to call it.
