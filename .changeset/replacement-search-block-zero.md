---
'@hashspan/viem': patch
---

The replacement search after a timed-out wait also finds a replacement mined in the first blocks of a chain when viem
is older than 2.29.1. Those releases send a nonce read at block 0 as a read at the latest block (wevm/viem#3629). On a
chain younger than the search window, such as a local devnet, the search then missed the block that took the nonce,
and the confirm span kept `error.type` `timeout`. The adapter now sends that read with the block number itself.
