---
'@hashspan/core': major
'@hashspan/viem': major
'@hashspan/cdp': major
'@hashspan/x402': major
---

1.0: the public API in the API reports is frozen; a breaking change to it now needs a major release (ADR 0027). The
semantic conventions stay `development` under their change policy. Removed, as announced:

- The positional forms of the handle methods: `send.end(hash, endTime)`, `send.fail(error, endTime, options)`,
  `confirm.end(receipt, endTime)`, `confirm.timeout(endTime)` and `confirm.fail(error, endTime)`. Use the options
  forms, such as `send.end({ hash }, { endTime })`. Called from JavaScript, the old forms still never throw, but the
  end time is ignored and a hash given as a string is not recorded.
- `blockchain.system` on spans and metric samples, and `ATTR_BLOCKCHAIN_SYSTEM`: use `blockchain.system.name` and
  `ATTR_BLOCKCHAIN_SYSTEM_NAME`, recorded since 0.11 with the same value. Schema version `0.4.0-dev`.
- `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT`, not recorded since 0.5: a confirm span that gave up waiting has `error.type`
  `timeout`.

The adapters call the options forms, so a tracker passed to them has to come from `@hashspan/core` 0.4 or later.
See docs/migrating-to-1.0.md.
