---
"@hashspan/viem": patch
---

For clients without a chain, no longer start a 30 s grace timer (and log that the chain id is unknown) when the chain
id arrived before the traced call settled.
