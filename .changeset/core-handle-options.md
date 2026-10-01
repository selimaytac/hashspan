---
'@hashspan/core': minor
---

Handle methods take an options object: `send.end({ hash }, { endTime })`, `send.fail(error, { endTime, errorType })`,
`confirm.end(receipt, { endTime })`, `confirm.timeout({ endTime })` and `confirm.fail(error, { endTime })` (ADR 0014).
The positional forms, `send.end(hash, endTime)` and `send.fail(error, endTime, { errorType })`, still work and are
deprecated until 1.0. An end time that is not a `Date`, an `HrTime` or a finite number is ignored.
