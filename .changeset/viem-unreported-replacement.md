---
'@hashspan/viem': patch
---

A transaction replaced before viem's `waitForTransactionReceipt` read it, such as one cancelled right after it was
sent, now ends its confirm span as `replaced`, with `blockchain.tx.replacement.hash`, and the replacing transaction's
receipt is recorded on its own confirm span. viem detects a replacement only after it has read the original
transaction, so its wait timed out and the span ended with `error.type` `timeout`. After such a timeout, hashspan
looks for the transaction with the same sender and nonce in the last 128 blocks (at most 13 requests, off the
caller's path) when the original was sent through the same `withHashspan()` result;
`blockchain.tx.replacement.reason` is then omitted, as no library reported one. The wait still rejects with viem's
`WaitForTransactionReceiptTimeoutError`, and `checkReplacement: false` turns the search off.

To know the nonce, a traced send that passes no `nonce`, and a raw send, now add one `eth_getTransactionByHash` of
the returned hash through the sending client, off the caller's path; its failure is only logged through `diag`. A
send that passes `nonce` adds no request.
