---
'@hashspan/viem': patch
---

A wait that rejects with an error whose `name` cannot be read (a throwing getter or Proxy trap) now ends its confirm
span with error status and `error.type` `_OTHER`, for transactions, user operations and call batches, instead of
leaving the span open until `flush()` gives up. The rejection still reaches the caller unchanged.
