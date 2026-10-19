---
"@hashspan/viem": minor
---

`watchUserOperation(client, options)` on the extension confirms a user operation sent elsewhere, such as by a smart
account SDK's `sendTransaction` or a hosted wallet that returns only a hash. With `{ bundleHash, sender, nonce? }`, it
reads the bundle transaction's receipt through a client of the chain's node and records the one `UserOperationEvent`
of the sender that the called contract or a canonical EntryPoint emitted; no match, several, or a receipt of more than
10 000 logs record nothing. With `{ userOpHash }`, it polls `eth_getUserOperationReceipt` through a bundler client and
ends as `timeout` when no receipt comes. The confirm span is the user operation's (ADR 0021): its success, cost and
paymaster, not the bundle transaction's status and fee. Like `watch()`, it never throws or waits, counts towards
`maxBackgroundConfirmations`, and `flush()` awaits it.
