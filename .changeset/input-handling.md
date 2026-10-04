---
'@hashspan/core': patch
'@hashspan/viem': patch
'@hashspan/x402': patch
---

More defensive handling of unusual input:

- A failed call is recorded as a failure (`error.type` and error status) also when its error cannot be read, for
  example an error whose `message` is a getter that throws or a Proxy. The message is read from the error's own
  `message` data property; a primitive thrown as is (a string, number, bigint or boolean) is recorded as text, other
  thrown objects with no message. Failures of the tracker itself are logged through `diag` with the error's type
  only.
- `sanitized` error messages also cut a URL that directly follows other text, such as `rpc_https://...`, to its
  origin.
- `gen_ai.agent.id` and `gen_ai.agent.name` taken from Baggage are recorded only if they have at most 128 letters,
  digits, spaces and `_ . : @ / -`. Values from the static `agent` option are recorded as given.
- With `recordFunctionArguments`, binary data (typed arrays, `ArrayBuffer`, `DataView`) is recorded as `0x` hex, so
  the address mode applies to it, instead of an object of its byte values.
- `withHashspan()` of the viem and x402 adapters no longer throws for options it cannot read (`null`, a Proxy, a
  getter that throws): unreadable options take their defaults, with a `diag` warning.
- The viem adapter keeps one copy of a `writeContract` ABI per contract function instead of one per transaction.
- A receipt whose `l1Fee` is not a hex quantity is recorded without `blockchain.tx.l1_fee` and `blockchain.tx.fee`;
  the rest of the receipt is recorded as usual instead of the confirmation ending as a failure.
