---
'@hashspan/core': minor
---

`ConfirmHandle.fail` of a transaction takes `FailOptions`, as the confirm handles of user operations and call batches
do: an adapter can record its own `error.type`, and `fail(undefined, { errorType })` records no exception event. The
viem adapter uses it for `not_on_chain`, a new `error.type` value of confirm spans and of the confirmation duration
histogram.
