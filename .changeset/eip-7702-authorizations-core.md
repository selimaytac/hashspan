---
'@hashspan/core': minor
---

`SendInput` takes an optional `authorizations` list, and the send span of an EIP-7702 (type 4) transaction records
`blockchain.tx.authorization.count`, and for each well-formed authorization (at most 64) its delegated address per
the address mode (`blockchain.tx.authorization.addresses`) and its chain id (`blockchain.tx.authorization.chain_ids`,
where `0` means every chain). Signatures and nonces are never recorded.
