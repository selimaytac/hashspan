# Migrating to 1.0

1.0 removes what 0.x deprecated and announced for removal ([ADR 0027](adr/0027-what-1-0-freezes.md)). If you only
use `withHashspan()`, `@hashspan/cdp` or `@hashspan/x402` with their own tracker, update the four packages together
and nothing else changes; the sections below concern code that calls `@hashspan/core` itself, a tracker you pass to
an adapter, and queries on `blockchain.system`.

## Handle methods take an options object

The positional forms deprecated in 0.4 ([ADR 0014](adr/0014-core-api-boundary.md)) are gone:

| Before | Since 1.0 |
|---|---|
| `send.end(hash, endTime)` | `send.end({ hash }, { endTime })` |
| `send.fail(error, endTime, { errorType })` | `send.fail(error, { endTime, errorType })` |
| `confirm.end(receipt, endTime)` | `confirm.end(receipt, { endTime })` |
| `confirm.timeout(endTime)` | `confirm.timeout({ endTime })` |
| `confirm.fail(error, endTime)` | `confirm.fail(error, { endTime })` |

```ts
const send = tracker.startSend({ chainId: 8453, from, to, value, startTime });
send.end({ hash }, { endTime });

const confirm = tracker.startConfirm({ chainId: 8453, hash, startTime });
confirm.end(receipt, { endTime });
```

TypeScript reports the old forms. Called from JavaScript, they still never throw, but what they pass is no longer
read: the span ends when the method is called, and a hash given as a string is not recorded.

A tracker you pass to an adapter (the `tracker` option) has to come from `@hashspan/core` 0.4 or later, since the
adapters now call the options forms.

## `blockchain.system` is no longer recorded

`blockchain.system.name` replaces it, with the same value `evm`, on every span and metric sample; 0.11 and 0.12
recorded both. Change queries, dashboards and alerts on `blockchain.system` (in Prometheus, `blockchain_system`) to
`blockchain.system.name` (`blockchain_system_name`), and `ATTR_BLOCKCHAIN_SYSTEM` to `ATTR_BLOCKCHAIN_SYSTEM_NAME`.
The schema version is `0.4.0-dev`.

## `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT` is removed

No span has recorded `blockchain.tx.status` `timeout` since 0.5: a confirm span that gave up waiting records
`error.type` `timeout` and no status ([ADR 0016](adr/0016-timeout-is-an-observer-outcome.md)). Compare with the string
`'timeout'` on `error.type` instead.

## What 1.0 promises

From 1.0 on, a breaking change to the public API needs a major release; the semantic conventions stay `development`
under their [change policy](semconv.md#change-policy). [ADR 0027](adr/0027-what-1-0-freezes.md) draws the line.
