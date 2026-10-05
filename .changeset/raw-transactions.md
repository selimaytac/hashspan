---
'@hashspan/viem': minor
---

`sendRawTransaction` and `sendRawTransactionSync`, which broadcast a transaction signed elsewhere, are now traced: the
send span records the chain id, recipient, value, nonce, function selector and EIP-7702 authorizations parsed from the
signed transaction (the client's chain id when the transaction has none), and the hash, but no sender, which only the
signature gives. A transaction viem cannot parse, or longer than 128 KiB, records the chain id and hash only. The sync
form records a confirm span over the call, like the other sync actions. viem's `sendTransaction` function called with
an extended client and a local account now records its send, as it sends through the client's `sendRawTransaction`.
