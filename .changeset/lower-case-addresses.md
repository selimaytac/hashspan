---
'@hashspan/core': minor
---

Addresses are recorded in lower case in the default `raw` address mode, so one address has one value on every span:
before, a value was recorded as its source gave it, for example a user operation's EntryPoint checksummed on its send
span and lower-cased on its confirm span when the bundler returned it that way. This changes the recorded form of
`blockchain.tx.from` (viem passes the account's checksummed address), `blockchain.tx.to`,
`blockchain.user_operation.sender`, `.entry_point` and `.paymaster`, `blockchain.call_batch.sender`,
`blockchain.payment.payer`, `.recipient` and `.asset`, and of addresses inside `blockchain.contract.function.arguments`,
`blockchain.tx.revert.reason`, `x402.resource`, `error.type` and sanitized error messages. Queries, dashboards and
redaction hooks that match checksummed addresses must match the lower-cased form. `hashed` mode is unchanged: it
already hashed the lower-cased address.
