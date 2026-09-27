---
"@hashspan/viem": minor
---

Record the revert reason of reverted transactions by replaying them on the previous block's state, including custom
errors for transactions sent with `writeContract`. The replay is bounded (10 s by default,
`decodeRevertReason: { timeoutMs }`), so an unresponsive provider cannot keep the confirm span open. Opt out with
`decodeRevertReason: false`.
