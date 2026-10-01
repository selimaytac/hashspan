---
'@hashspan/cdp': minor
---

Traced CDP calls now run while their send span is the active span, so spans that HTTP instrumentation creates for the
CDP API request nest under the send span instead of beside it (ADR 0015). Background confirmations and the code after
the call stay under the caller; with a tracker from `@hashspan/core` before 0.4, the call runs in the caller's context
as before.
