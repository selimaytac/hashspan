---
'@hashspan/core': patch
'@hashspan/viem': patch
'@hashspan/cdp': patch
---

README and package description: hashspan also traces the transactions of services that are not agents, such as
payment workers, wallet backends and bots, under whatever span is active.

A transaction sent through a wallet service's own API gets a send span too: the viem README shows how to record the
API call with the core's tracker and confirm it with `watch()` on the same tracker, so the confirm span links to it.

The viem README has a "Many transactions" section: what `maxBackgroundConfirmations`, `linkTtlMs`,
`maxTrackedTransactions` and sampling mean for a worker or a bot that sends many transactions; metrics record every
transaction whatever the sampler decides.
