# @hashspan/core

## 1.0.0-rc.0

### Major Changes

- [#391](https://github.com/selimaytac/hashspan/pull/391) [`874ecc5`](https://github.com/selimaytac/hashspan/commit/874ecc558aa4f6126458a7f0bd0067123152e5b2) Thanks [@selimaytac](https://github.com/selimaytac)! - 1.0: the public API in the API reports is frozen; a breaking change to it now needs a major release (ADR 0027). The
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

### Patch Changes

- [#392](https://github.com/selimaytac/hashspan/pull/392) [`622b52d`](https://github.com/selimaytac/hashspan/commit/622b52d5d5db9a02dc5c9bea88d04d4210b1214b) Thanks [@selimaytac](https://github.com/selimaytac)! - `sanitized` error messages: a hex value that is still cut at the end of the scanned part of a long first line, and is
  no longer than the hex values kept, is dropped instead of recorded in part.

- [#387](https://github.com/selimaytac/hashspan/pull/387) [`81bb81a`](https://github.com/selimaytac/hashspan/commit/81bb81a8452584f8d237c1ebf2bf550ffc3856a4) Thanks [@selimaytac](https://github.com/selimaytac)! - README and package description: hashspan also traces the transactions of services that are not agents, such as
  payment workers, wallet backends and bots, under whatever span is active.
  
  A transaction sent through a wallet service's own API gets a send span too: the viem README shows how to record the
  API call with the core's tracker and confirm it with `watch()` on the same tracker, so the confirm span links to it.
  
  The viem README has a "Many transactions" section: what `maxBackgroundConfirmations`, `linkTtlMs`,
  `maxTrackedTransactions` and sampling mean for a worker or a bot that sends many transactions; metrics record every
  transaction whatever the sampler decides.

## 0.12.0

### Minor Changes

- [#383](https://github.com/selimaytac/hashspan/pull/383) [`4fe6f6c`](https://github.com/selimaytac/hashspan/commit/4fe6f6c06e0423baa4ef69d03b42eaeff18f6e50) Thanks [@selimaytac](https://github.com/selimaytac)! - `ConfirmHandle.fail` of a transaction takes `FailOptions`, as the confirm handles of user operations and call batches
  do: an adapter can record its own `error.type`, and `fail(undefined, { errorType })` records no exception event. The
  viem adapter uses it for `not_on_chain`, a new `error.type` value of confirm spans and of the confirmation duration
  histogram.

### Patch Changes

- [#384](https://github.com/selimaytac/hashspan/pull/384) [`43c0e9d`](https://github.com/selimaytac/hashspan/commit/43c0e9d0de5e9aa83ca237088240ad3ee715bc79) Thanks [@selimaytac](https://github.com/selimaytac)! - A tracker whose first transaction is sent before an SDK registers a global meter provider now records metrics once
  one is registered. It no longer keeps the histograms of `@opentelemetry/api`'s default no-op meter provider, which stay
  no-op: while no `meterProvider` option is given and the global provider is still the no-op one, the tracker asks again
  at the next transaction, and keeps the histograms once a real provider answers. Spans already behaved this way.
  Transactions sent before the SDK started are not recorded.

- [#385](https://github.com/selimaytac/hashspan/pull/385) [`743856f`](https://github.com/selimaytac/hashspan/commit/743856f1fe97b2d83fde3d63d2914fb2feee823b) Thanks [@selimaytac](https://github.com/selimaytac)! - More bounds on what telemetry reads:
  
  - A sanitized error message scans at most the first 4096 characters of its first line for URLs and hex values (a hex
    value cut there is still recorded as without the cut); text past that bound is not recorded, and the recorded
    message is cut to 256 characters as before. A URL cut at that bound before its path is recorded as `<url>`.
  - `waitForTransactionReceipt` in `@hashspan/viem`, and the wait of a network-scoped account in `@hashspan/cdp`, read at
    most 64 objects of the arguments' prototype chain when they look up `onReplaced`; arguments with a longer chain are
    passed on untraced and unchanged, as arguments that cannot be read are.
  - `@hashspan/cdp` adds its `onReplaced` to a network-scoped account's wait options only when they are a plain object
    (prototype `Object.prototype` or `null`). Other options, such as a class instance, are passed to the SDK as they are:
    the wait is traced, but a replacement viem reports for it is not attributed.
  
  The options of `withHashspan()` in `@hashspan/viem`, `@hashspan/cdp` and `@hashspan/x402` are read from the object's
  own enumerable properties, so options inherited through a prototype are ignored (ADR 0025). This is now stated in the
  options' documentation and the package READMEs.

- [#380](https://github.com/selimaytac/hashspan/pull/380) [`a3c6f3a`](https://github.com/selimaytac/hashspan/commit/a3c6f3ab62289b6488e0217943124e105b57d826) Thanks [@selimaytac](https://github.com/selimaytac)! - A user operation receipt whose `success` is present but not a boolean (`null`, a string, a number) now ends the
  confirm span as a failure with `error.type` `_OTHER`, and its confirmation duration sample carries `error.type`
  `_OTHER`, with no fee sample, as a transaction receipt with an unknown status does. Until now such a span ended
  without an error status and its sample had no outcome label. A receipt without `success`, as `@hashspan/cdp` reports
  an operation whose outcome it does not know, ends as before: no error and no outcome label. `success` is read from an
  own data property only.

## 0.11.0

### Minor Changes

- [#351](https://github.com/selimaytac/hashspan/pull/351) [`044acaa`](https://github.com/selimaytac/hashspan/commit/044acaae5d1b096995a2b28d4a8d74fa9d149545) Thanks [@selimaytac](https://github.com/selimaytac)! - `blockchain.client.fee` samples whose fee the traced sender did not pay now carry `blockchain.fee.payer`:
  `facilitator` for the settlement transaction of a payment, `paymaster` for a user operation a paymaster paid for.
  Samples without it are fees the senders paid, as all samples were counted before; filter on it to chart what an
  agent spent. New exports: `ATTR_BLOCKCHAIN_FEE_PAYER`, `BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR` and
  `BLOCKCHAIN_FEE_PAYER_VALUE_PAYMASTER`.

- [#365](https://github.com/selimaytac/hashspan/pull/365) [`2e0efb5`](https://github.com/selimaytac/hashspan/commit/2e0efb5fbd5039e94d07ac36b9c9bea9d2db09cd) Thanks [@selimaytac](https://github.com/selimaytac)! - `blockchain.system` is renamed to `blockchain.system.name`, as OpenTelemetry names the system attribute of its
  `db.*` and `rpc.*` conventions. Following the change policy of the semantic conventions, every span and metric sample
  that records `blockchain.system` now records `blockchain.system.name` too, with the same value (`evm`); the redaction
  hook's fail-closed set keeps both. Metric series therefore gain a label, `blockchain_system_name` in Prometheus: each series ends at the upgrade and
  a new one starts, so `rate()` and `increase()` over a window that spans the upgrade undercount once.
  Queries and dashboards should move to the new name: `blockchain.system` and the constant `ATTR_BLOCKCHAIN_SYSTEM`
  are deprecated and removed in 1.0. New export: `ATTR_BLOCKCHAIN_SYSTEM_NAME`. The semantic conventions schema
  version is `0.3.0-dev`. The doc comment of the `redact` option lists every key the fail-closed set keeps, call
  batch keys included.

### Patch Changes

- [#364](https://github.com/selimaytac/hashspan/pull/364) [`4d7af1b`](https://github.com/selimaytac/hashspan/commit/4d7af1b70dd65ab0633e1a1a7df940bb52e437e5) Thanks [@selimaytac](https://github.com/selimaytac)! - The doc comment of the attribute keys links to the change policy of the semantic conventions, which says how
  attribute names are renamed and removed.

- [#352](https://github.com/selimaytac/hashspan/pull/352) [`96a967f`](https://github.com/selimaytac/hashspan/commit/96a967f92de7df92327fd04b3ba6d56fda57976d) Thanks [@selimaytac](https://github.com/selimaytac)! - A receipt without a readable block number or gas used, such as what viem returns when a node answers with something
  that is not a receipt, now ends the confirm span with error status and `error.type` `_OTHER`, records one confirmation
  sample, and lets a later wait record the receipt, as docs/semconv.md describes. Before, the span ended with no outcome
  and no error, and no confirmation sample was recorded.

- [#362](https://github.com/selimaytac/hashspan/pull/362) [`0b820da`](https://github.com/selimaytac/hashspan/commit/0b820da151b5025285aedf9576fc415d16480cde) Thanks [@selimaytac](https://github.com/selimaytac)! - The type declarations document every export, and every member of the exported interfaces, with a doc comment.

- [#349](https://github.com/selimaytac/hashspan/pull/349) [`85c741a`](https://github.com/selimaytac/hashspan/commit/85c741ab262c254fc37816c8323cd409fab11955) Thanks [@selimaytac](https://github.com/selimaytac)! - In `off` and `hashed` address mode, an address that follows another hex value directly (`0x…0x<address>`) is now
  recognised: a `0x` starts a new hex value. Before, the first value took the second address's leading `0`, and the
  remaining 40 digits were recorded as they were. Found by the new property-based tests. A `0` followed by an `x` that starts no hex value stays part of the value before it, so an address ending in `0` and
  followed by text such as `xyz` is recognised too.

- [#359](https://github.com/selimaytac/hashspan/pull/359) [`2498693`](https://github.com/selimaytac/hashspan/commit/24986931fb8a7596c823af20a1732b001f57906e) Thanks [@selimaytac](https://github.com/selimaytac)! - More defensive handling of unusual input:
  
  - A failed call is recorded as a failure (`error.type` and error status) also when its error cannot be read, for
    example an error whose `message` is a getter that throws, or a Proxy; the event then has no message. A primitive
    thrown as is (a string, number, bigint or boolean) is recorded as text; a thrown object that is not an Error, with
    no message. Failures of the tracker itself are logged through `diag` with the error's type only.
  - `sanitized` error messages also cut a URL that directly follows other text, such as `rpc_https://...`, to its
    origin.
  - `gen_ai.agent.id` and `gen_ai.agent.name` taken from Baggage are recorded only if they have at most 128 letters,
    digits, spaces and `_ . : @ / -`. Values from the static `agent` option are recorded as given.
  - With `recordFunctionArguments`, binary data (typed arrays, `ArrayBuffer`, `DataView`) is recorded as `0x` hex, so
    the address mode applies to it, instead of an object of its byte values.
  - `withHashspan()` of the viem, cdp and x402 adapters no longer throws for options it cannot read (`null`, a Proxy, a
    getter that throws): unreadable options take their defaults, with a `diag` warning.
  - The adapters' `diag` messages include an error's name only when it is short text; another name, such as a symbol,
    is logged as unknown.
  - The viem adapter keeps one copy of a `writeContract` ABI per contract function instead of one per transaction.
  - A receipt whose `l1Fee` is not a hex quantity is recorded without `blockchain.tx.l1_fee` and `blockchain.tx.fee`;
    the rest of the receipt is recorded as usual instead of the confirmation ending as a failure.

- [#369](https://github.com/selimaytac/hashspan/pull/369) [`1ada0ac`](https://github.com/selimaytac/hashspan/commit/1ada0aca407b91c9fa8ecde983a074a60833a27f) Thanks [@selimaytac](https://github.com/selimaytac)! - README states the package's known limits.

## 0.10.0

### Minor Changes

- [#308](https://github.com/selimaytac/hashspan/pull/308) [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f) Thanks [@selimaytac](https://github.com/selimaytac)! - A confirm span ends even when its receipt cannot be read (a throwing Proxy, `null`), with `error.type` `_OTHER`;
  before, it stayed open and was never exported. A receipt status other than `success` or `reverted` is no longer
  recorded as `success`: the span ends with `error.type` `_OTHER` and no `blockchain.tx.status`.
  `CallBatchConfirmHandle.end` no longer throws for a status that cannot be read; the span ends with `error.type`
  `_OTHER`.

### Patch Changes

- [#338](https://github.com/selimaytac/hashspan/pull/338) [`03889c2`](https://github.com/selimaytac/hashspan/commit/03889c2bb75eac3a48c1ff7b16b6d335e1a543aa) Thanks [@selimaytac](https://github.com/selimaytac)! - The tracker validates and bounds every value it records, also those a caller or an adapter passes to it (ADR 0025).
  A call without a positive safe integer chain id, or a confirmation without a 32-byte hex hash, records no span; a
  send hash that is not one is not recorded. A send records only well-formed addresses, values, nonces, function names
  and selectors; a receipt's block number and gas used must be non-negative safe integers, and its gas price and L1 fee
  non-negative integers, with `blockchain.tx.fee` omitted unless every part of it is known. `error.type` and
  `exception.type` take an error's name only if it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters),
  else `_OTHER`. Revert reasons are cut to 1024 characters, and sanitized messages and function arguments are cut
  without splitting a hex value. At most 64 receipts of a call batch status and 64 transaction hashes of a call batch
  send are read. `createTxTracker()` no longer throws for options it cannot read, and uses the default for a `linkTtlMs`
  or `maxTrackedTransactions` that is not a positive number. Valid values are recorded as before.

## 0.9.0

### Minor Changes

- [#198](https://github.com/selimaytac/hashspan/pull/198) [`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc) Thanks [@selimaytac](https://github.com/selimaytac)! - Call batches of EIP-5792 `wallet_sendCalls` (ADR 0022): `tracker.startCallBatchSend()` records handing a batch to a
  wallet as a `send {chainId}` span with `blockchain.call_batch.id`, `.sender` and `.call_count`, and
  `tracker.startCallBatchConfirm()` joins its `confirm {chainId}` span, keyed by chain and batch id apart from
  transactions and user operations, with `blockchain.call_batch.status` (`success`, `reverted`,
  `partially_reverted` for codes 200, 500, 600), `.status_code`, `.atomic` and `.transaction_hashes`. Code 400 ends
  with `error.type` `failed`, any other code with `_OTHER`, and a pending result without an outcome; no fee is
  recorded. Batch ids must be `0x`-prefixed hex. Transactions an account sent itself for a batch are linked to its send
  span. Metrics of batches carry `blockchain.operation.subject` `call_batch` and the batch status, never raw codes.

- [#247](https://github.com/selimaytac/hashspan/pull/247) [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a) Thanks [@selimaytac](https://github.com/selimaytac)! - `SendInput` takes an optional `authorizations` list, and the send span of an EIP-7702 (type 4) transaction records
  `blockchain.tx.authorization.count`, and for each well-formed authorization (at most 64) its delegated address per
  the address mode (`blockchain.tx.authorization.addresses`) and its chain id (`blockchain.tx.authorization.chain_ids`,
  where `0` means every chain). Signatures and nonces are never recorded.

- [#231](https://github.com/selimaytac/hashspan/pull/231) [`c9795db`](https://github.com/selimaytac/hashspan/commit/c9795db3a1aa46ea7f93b9f7130c73c9a0a0e4e0) Thanks [@selimaytac](https://github.com/selimaytac)! - Addresses are recorded in lower case in the default `raw` address mode, so one address has one value on every span:
  before, a value was recorded as its source gave it, for example a user operation's EntryPoint checksummed on its send
  span and lower-cased on its confirm span when the bundler returned it that way. This changes the recorded form of
  `blockchain.tx.from` (viem passes the account's checksummed address), `blockchain.tx.to`,
  `blockchain.user_operation.sender`, `.entry_point` and `.paymaster`, `blockchain.call_batch.sender`,
  `blockchain.payment.payer`, `.recipient` and `.asset`, and of addresses inside `blockchain.contract.function.arguments`,
  `blockchain.tx.revert.reason`, `x402.resource`, `error.type` and sanitized error messages. Queries, dashboards and
  redaction hooks that match checksummed addresses must match the lower-cased form. `hashed` mode is unchanged: it
  already hashed the lower-cased address.

### Patch Changes

- [#252](https://github.com/selimaytac/hashspan/pull/252) [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6) Thanks [@selimaytac](https://github.com/selimaytac)! - `x402.resource` cut to its 512-character bound no longer keeps part of a hex value that the cut splits: the part
  left was too short to be recognised as an address, so in `off` and `hashed` address mode most of an address in a long
  resource path could be recorded. The hex value at the cut is now dropped whole.

- [#219](https://github.com/selimaytac/hashspan/pull/219) [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac) Thanks [@selimaytac](https://github.com/selimaytac)! - The package's npm homepage is now https://hashspan.dev.

- [#253](https://github.com/selimaytac/hashspan/pull/253) [`ad6b069`](https://github.com/selimaytac/hashspan/commit/ad6b069a70f703785576dde4e45051d1419b34e8) Thanks [@selimaytac](https://github.com/selimaytac)! - `errorMessages: 'sanitized'` now cuts every URL in the recorded first line to its scheme, host and port, and records
  `<url>` for one whose user info hides a `?` or `#`. viem keeps the request URL off the first line, but a custom
  EIP-1193 transport or another library can put it there, with an API key in its path or query.

## 0.8.0

### Minor Changes

- [#178](https://github.com/selimaytac/hashspan/pull/178) [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329) Thanks [@selimaytac](https://github.com/selimaytac)! - User operations of ERC-4337 smart accounts (ADR 0021): `tracker.startUserOperationSend()` records handing an
  operation to a bundler as a `send {chainId}` span with `blockchain.user_operation.hash`, `.sender`, `.entry_point`
  and `.call_count`, and `tracker.startUserOperationConfirm()` joins its `confirm {chainId}` span, keyed by chain and
  user operation hash apart from transactions, with `blockchain.user_operation.success`, `.gas.used`, `.gas.cost`,
  `.nonce` and `.paymaster`, and the bundle transaction's `blockchain.tx.hash` and `blockchain.block.number`. A reverted
  operation ends with `error.type` `reverted`; no `blockchain.tx.status` or bundle fee is recorded. The send,
  confirmation and fee histograms record user operations with `blockchain.operation.subject` `user_operation`, and
  the fee histogram records the operation's own cost. When the redaction hook fails, the user operation hash and
  success flag are kept.

### Patch Changes

- [#177](https://github.com/selimaytac/hashspan/pull/177) [`1ba39b9`](https://github.com/selimaytac/hashspan/commit/1ba39b9d18ef63bb4d79ea691f9080cb1d8a8dc5) Thanks [@selimaytac](https://github.com/selimaytac)! - The send and confirmation histograms keep `error.type` only when it is an error class name of letters or a
  lower-case code (such as `timeout` or an adapter's error code); any other value, such as a custom error name with an
  identifier or an address in it, is recorded as `_OTHER`, so metric labels stay low-cardinality and free of
  addresses. Spans keep their own `error.type`.

## 0.7.0

### Minor Changes

- [#148](https://github.com/selimaytac/hashspan/pull/148) [`3fbc570`](https://github.com/selimaytac/hashspan/commit/3fbc57094efd99dd218aadb5e1d72f15bbbd4d8c) Thanks [@selimaytac](https://github.com/selimaytac)! - The tracker records metrics (ADR 0020): `blockchain.client.send.duration` and
  `blockchain.client.confirmation.duration` histograms in seconds and `blockchain.client.fee` in wei, with the chain
  and the outcome as their only attributes. They use the global meter provider, or the new `meterProvider` option,
  and record nothing until a metrics SDK is set up. The metric names are exported as constants.

## 0.6.0

### Minor Changes

- [#132](https://github.com/selimaytac/hashspan/pull/132) [`7ba73bb`](https://github.com/selimaytac/hashspan/commit/7ba73bb2e2a87c157c2819d23b66b6266925472a) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `blockchain.payment.verified` (ADR 0017): `PaymentSettlement.verified` records whether the settlement
  transaction's receipt carries the payment, as an adapter checked it from the payer's own data. It is not an error,
  and it is kept when the redaction hook fails. `PaymentHandle.link(hash)` links the settling transaction's
  confirm span to a payment span that stays open until its receipt is checked.

## 0.5.0

### Minor Changes

- [#127](https://github.com/selimaytac/hashspan/pull/127) [`2c2ddb6`](https://github.com/selimaytac/hashspan/commit/2c2ddb61321580b0dcca205faef5e9a6a15ca43b) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `blockchain.payment.settled_amount`: the amount the settling party reports it settled, recorded as reported next
  to `blockchain.payment.amount`, which keeps the amount the payer knew. With x402's `upto` scheme, it shows what was
  actually charged when that is less than the authorized maximum.

- [#120](https://github.com/selimaytac/hashspan/pull/120) [`7ca4af6`](https://github.com/selimaytac/hashspan/commit/7ca4af6541f09ede2e328cd15eaee2e530a6a48c) Thanks [@selimaytac](https://github.com/selimaytac)! - A confirm span that gave up waiting, on its own timeout or in `flush()`, no longer records `blockchain.tx.status`
  `timeout`, as announced in 0.4.0 (ADR 0016). It keeps error status and `error.type` `timeout`; query that instead.
  `blockchain.tx.status` now comes only from chain data (`success`, `reverted`, `replaced`), and the semantic
  conventions schema version is `0.2.0-dev`. The deprecated constant `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT` stays
  exported until 1.0.

## 0.4.0

### Minor Changes

- [#107](https://github.com/selimaytac/hashspan/pull/107) [`c20d91d`](https://github.com/selimaytac/hashspan/commit/c20d91da7ec552fc9d6a6d50c62b8eb4b3a2412f) Thanks [@selimaytac](https://github.com/selimaytac)! - Deprecate the value `timeout` of `blockchain.tx.status` and the constant `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT`
  (ADR 0016). `blockchain.tx.status` describes the transaction as the chain recorded it; a confirm span that gave up
  waiting already records error status and `error.type` `timeout`, so query that instead. The value is still recorded
  in this release and stops being recorded in the next minor release; the constant is removed in 1.0.

- [#94](https://github.com/selimaytac/hashspan/pull/94) [`15f16ba`](https://github.com/selimaytac/hashspan/commit/15f16bac79dc5dc13506a224fdea9c4abf5d0a34) Thanks [@selimaytac](https://github.com/selimaytac)! - Handle methods take an options object: `send.end({ hash }, { endTime })`, `send.fail(error, { endTime, errorType })`,
  `confirm.end(receipt, { endTime })`, `confirm.timeout({ endTime })` and `confirm.fail(error, { endTime })` (ADR 0014).
  The positional forms still work and are deprecated until 1.0: `send.end(hash, endTime)`,
  `send.fail(error, endTime, { errorType })`, `confirm.end(receipt, endTime)`, `confirm.timeout(endTime)` and
  `confirm.fail(error, endTime)`. An end time that is not a `Date`, an `HrTime` or a finite number is ignored.

- [#92](https://github.com/selimaytac/hashspan/pull/92) [`990a2ea`](https://github.com/selimaytac/hashspan/commit/990a2ea75536f6451923bbb51d1f4684aee48b3d) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `tracker.startPayment()`, which records a payment that another party settles on chain, such as an x402
  facilitator, as a `payment {chainId}` span with the new `blockchain.payment.*` and `x402.*` attributes. A settlement
  with a transaction hash links that transaction's confirm span to the payment span (ADR 0013). The settling party's
  report never replaces what the payer knew: its payer and amount fill only fields the input left empty, and its hash
  does not take over a link the tracker already has. A payment whose
  outcome was never learned ends with `timeout()`: `error.type` `timeout` and no `blockchain.payment.status`. The
  `paymentResource` option sets how much of the paid resource's URL `x402.resource` records: `origin` (default), `path`
  or `off`, at most 512 characters.

- [#93](https://github.com/selimaytac/hashspan/pull/93) [`2f424f2`](https://github.com/selimaytac/hashspan/commit/2f424f2896d66d7d6b32e448b5643c81f0bee1a2) Thanks [@selimaytac](https://github.com/selimaytac)! - `TxTracker` and its handles are produced by `createTxTracker()` only and are not meant to be implemented: members
  may be added to them in minor releases (ADR 0014). This release adds `startPayment` to the tracker and `context` to
  the send handle, so a hand-written tracker no longer type-checks; use `createTxTracker()` instead, which adapters
  accept to share one tracker between them.

- [#103](https://github.com/selimaytac/hashspan/pull/103) [`905d2f8`](https://github.com/selimaytac/hashspan/commit/905d2f859b1130657ab92d11dcb90bae86e7517e) Thanks [@selimaytac](https://github.com/selimaytac)! - `SendHandle.context` is the parent context with the send span set: run the call that sends the transaction in it,
  e.g. `await context.with(send.context, () => sendSomehow())`, so that spans of wallet, RPC or HTTP instrumentation
  nest under the send span (ADR 0015). When starting the send span fails, it is the parent context.

## 0.3.0

### Minor Changes

- [#67](https://github.com/selimaytac/hashspan/pull/67) [`28a83c2`](https://github.com/selimaytac/hashspan/commit/28a83c265f11836a5eca26a99971daa402abc4d3) Thanks [@selimaytac](https://github.com/selimaytac)! - `SendHandle.fail(error, endTime, { errorType })` records a library's machine-readable error code as `error.type` instead
  of the error's class name, when it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters). `exception.type`
  stays the class name.

## 0.2.0

### Minor Changes

- [#50](https://github.com/selimaytac/hashspan/pull/50) [`6da02c7`](https://github.com/selimaytac/hashspan/commit/6da02c74d872a05e04f496cc10fcc9a04fb43c6c) Thanks [@selimaytac](https://github.com/selimaytac)! - A field set in the static `agent` option now always wins over the Baggage entries `gen_ai.agent.id` /
  `gen_ai.agent.name`; Baggage only fills fields the option leaves unset. The new `agentFromBaggage: false` option stops
  reading agent identity from Baggage, for services that accept requests from outside their trust boundary, where a
  caller could otherwise attribute transactions to another agent.

- [#45](https://github.com/selimaytac/hashspan/pull/45) [`7dc19d1`](https://github.com/selimaytac/hashspan/commit/7dc19d16f72e0c1ed8308ecfa006afacc3989c48) Thanks [@selimaytac](https://github.com/selimaytac)! - Require Node.js 22.3 or later (`engines`). Node.js 18 and 20 have reached end of life, and `hashed` address mode relies
  on `process.getBuiltinModule`, available from Node.js 22.3; the packages are built for that target.

## 0.1.0

### Minor Changes

- [#1](https://github.com/selimaytac/hashspan/pull/1) [`4059847`](https://github.com/selimaytac/hashspan/commit/405984785d2bba6a1887195388d3082b63a3a7e2) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `createTxTracker()`, the transaction lifecycle tracker:
  
  - `send` and `confirm` spans linked by transaction hash, with one confirm span per transaction and tracker: waits
    for the same transaction join the in-flight span, and a receipt from any of them ends it
  - receipt status, block, gas, OP-stack L1 fee and total fee; reverted and timed-out transactions set error status
  - agent identity from Baggage or a static fallback
  - address privacy modes (`raw`, `hashed`, `off`) and a fail-closed redaction hook, which also runs on exception
    attributes
  - decoded call arguments are recorded only with `recordFunctionArguments`, as a JSON array with addresses per
    address mode, without calling `toJSON()` or getters
  - in `hashed` and `off` mode, hex values longer than an address are recorded as `<hex>`, so a padded or
    ABI-encoded address cannot leak through arguments, revert reasons or error messages
  - error messages are kept out of spans by default; `errorMessages` records a sanitized first line or the full
    message and stack trace
  - optional `startTime` / `endTime` on every input and handle method, so integrations can record a call after the fact
  - instrumentation failures are reported through `diag` and never thrown into the caller

- [#10](https://github.com/selimaytac/hashspan/pull/10) [`09923bd`](https://github.com/selimaytac/hashspan/commit/09923bd42a27ba5ad1417185278ec4670b6d693a) Thanks [@selimaytac](https://github.com/selimaytac)! - Attribute receipts of replaced transactions to the transaction that was mined. `ReceiptLike` accepts optional
  `transactionHash` and `replacementReason`; when the hash differs from the awaited one, the awaited transaction's
  confirm span ends with `blockchain.tx.status = replaced`, `blockchain.tx.replacement.hash` and
  `blockchain.tx.replacement.reason`, and the receipt is recorded on the confirm span of the mined transaction. The
  viem adapter reports replacements from `onReplaced`, keeps the caller's callback and result unchanged, and decodes the
  revert reason of a replacing call to the same contract with the original ABI.
