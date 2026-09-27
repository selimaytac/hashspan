---
"@hashspan/viem": patch
---

Background confirmation no longer shares viem's receipt poll with the caller's own `waitForTransactionReceipt` on the
same client. Before, the caller's wait ran with the background options: it rejected with a timeout when the
background confirmation timed out first, and resolved without waiting for the requested `confirmations`.
