---
'@hashspan/viem': minor
---

Smart accounts (ADR 0021): on a bundler client from `createBundlerClient`, `withHashspan()` also traces
`sendUserOperation` as a `send` span, with the send span active while it runs, and `waitForUserOperationReceipt` as
a `confirm` span linked to it, with the operation's success, gas used, cost, nonce, paymaster and decoded revert
reason, and the bundle transaction's hash and block. A reverted operation ends with `error.type` `reverted`, and a
wait that gives up as `timeout`. The chain id comes from the bundler client, or the client it was created with, and
is otherwise resolved after the call. Requires `@hashspan/core` with user operations; with an older tracker,
nothing is recorded for them.
