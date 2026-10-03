# @hashspan/viem

## 0.9.0

### Minor Changes

- [#198](https://github.com/selimaytac/hashspan/pull/198) [`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc) Thanks [@selimaytac](https://github.com/selimaytac)! - `withHashspan()` traces EIP-5792 call batches (ADR 0022): `sendCalls`, `waitForCallsStatus` and `sendCallsSync` of a
  wallet client record `send` and `confirm` spans identified by the batch id. With `experimental_fallback`, the plain
  transactions viem sends are linked to the batch's send span and always confirmed as transactions, with their fees.
  With a tracker from an older `@hashspan/core`, batches are not traced.

- [#247](https://github.com/selimaytac/hashspan/pull/247) [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a) Thanks [@selimaytac](https://github.com/selimaytac)! - `sendTransaction` and `writeContract` record the `authorizationList` of an EIP-7702 transaction on its send span:
  how many authorizations, each delegated address and its chain id, read from own data properties (only the first 64
  entries are read; all are counted). Signatures and nonces never reach telemetry. With an older `@hashspan/core`, the
  list is not recorded.

### Patch Changes

- [#252](https://github.com/selimaytac/hashspan/pull/252) [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6) Thanks [@selimaytac](https://github.com/selimaytac)! - A revert reason cut to its 1024-character bound no longer keeps part of a hex value that the cut splits: the part left
  was too short to be recognised as an address, so in `off` and `hashed` address mode most of an address in a long
  revert reason could be recorded. The hex value at the cut is now dropped whole.

- [#219](https://github.com/selimaytac/hashspan/pull/219) [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac) Thanks [@selimaytac](https://github.com/selimaytac)! - The package's npm homepage is now https://hashspan.dev.

- [#232](https://github.com/selimaytac/hashspan/pull/232) [`18f2f3c`](https://github.com/selimaytac/hashspan/commit/18f2f3c1a94ab75eb49bb027f34d61355d13e3b6) Thanks [@selimaytac](https://github.com/selimaytac)! - A wait that rejects with an error whose `name` cannot be read (a throwing getter or Proxy trap) now ends its confirm
  span with error status and `error.type` `_OTHER`, for transactions, user operations and call batches, instead of
  leaving the span open until `flush()` gives up. The rejection still reaches the caller unchanged.

- [#254](https://github.com/selimaytac/hashspan/pull/254) [`0be88f5`](https://github.com/selimaytac/hashspan/commit/0be88f5edf0575745bd8a989199bb4fac3bf1110) Thanks [@selimaytac](https://github.com/selimaytac)! - `watch()` with a `chainId` and a client without a chain now asks the client for its chain id (`eth_chainId`) and
  records nothing when the two differ, as it already did for a client with a chain. Before, the transaction was polled
  on the client's chain and recorded under the given chain id. In `@hashspan/x402` that chain id comes from the paid
  server, so a reader without a chain could record a confirm span, and its `blockchain.chain.id` metric label, for any
  chain the server named.
- Updated dependencies [[`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc), [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a), [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6), [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac), [`c9795db`](https://github.com/selimaytac/hashspan/commit/c9795db3a1aa46ea7f93b9f7130c73c9a0a0e4e0), [`ad6b069`](https://github.com/selimaytac/hashspan/commit/ad6b069a70f703785576dde4e45051d1419b34e8)]:
  - @hashspan/core@0.9.0

## 0.8.2

### Patch Changes

- [#194](https://github.com/selimaytac/hashspan/pull/194) [`b9fc0ee`](https://github.com/selimaytac/hashspan/commit/b9fc0ee2d1f7588f9e75eda55ca9f695f05675b0) Thanks [@selimaytac](https://github.com/selimaytac)! - The revert reason of a transaction that calls a contract created earlier in the same block is now recorded: when the
  replay on the previous block does not revert (the contract has no code there yet), the transaction is replayed once
  more on its own block (ADR 0005 amendment). It costs one more `eth_call`, only in that case.

## 0.8.0

### Minor Changes

- [#178](https://github.com/selimaytac/hashspan/pull/178) [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329) Thanks [@selimaytac](https://github.com/selimaytac)! - Smart accounts (ADR 0021): on a bundler client from `createBundlerClient`, `withHashspan()` also traces
  `sendUserOperation` as a `send` span, with the send span active while it runs, and `waitForUserOperationReceipt` as
  a `confirm` span linked to it, with the operation's success, gas used, cost, nonce, paymaster and decoded revert
  reason, and the bundle transaction's hash and block. A reverted operation ends with `error.type` `reverted`, and a
  wait that gives up as `timeout`. The chain id comes from the bundler client, or the client it was created with, and
  is otherwise resolved after the call. Requires `@hashspan/core` with user operations; with an older tracker,
  nothing is recorded for them.

### Patch Changes

- [#183](https://github.com/selimaytac/hashspan/pull/183) [`8446f17`](https://github.com/selimaytac/hashspan/commit/8446f17465b63d1660932b6edc1f9426fb6c4efa) Thanks [@selimaytac](https://github.com/selimaytac)! - Confirm spans record fees from the sealed receipt (ADR 0024). On flashblocks RPCs such as Base's, a receipt returned
  before its block is sealed (zero block hash) can carry the L1 fee of another transaction; the span now waits, off the
  caller's path and for at most 30 s, for the sealed receipt, and records the preconfirmation without
  `effective_gas_price`, `l1_fee` and `fee` if it does not come. The caller's receipt is unchanged.

- [#175](https://github.com/selimaytac/hashspan/pull/175) [`09628e2`](https://github.com/selimaytac/hashspan/commit/09628e2c64131d5df3deee0c58e69c4859f4df3a) Thanks [@selimaytac](https://github.com/selimaytac)! - `traceTransport()` reads a request's `method` only from an own data property, as the other traced actions read
  their arguments: a request whose `method` is an accessor, or whose properties cannot be read, is sent untraced, and
  no getter of the caller's runs an extra time.
- Updated dependencies [[`1ba39b9`](https://github.com/selimaytac/hashspan/commit/1ba39b9d18ef63bb4d79ea691f9080cb1d8a8dc5), [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329)]:
  - @hashspan/core@0.8.0

## 0.7.0

### Minor Changes

- [#145](https://github.com/selimaytac/hashspan/pull/145) [`d1be4f8`](https://github.com/selimaytac/hashspan/commit/d1be4f8ec2deddb0060dc69d7de0b906ec4c3dcd) Thanks [@selimaytac](https://github.com/selimaytac)! - `maxBackgroundConfirmations` (default 256) limits how many background confirmations, from
  `confirm: { mode: 'background' }` and `watch()`, poll at once (ADR 0018). A confirmation over the limit is not
  started: no confirm span is recorded, `watch()` calls `onReceipt` with `undefined`, and a `diag` warning is logged.
  The caller's own waits are not counted.

- [#147](https://github.com/selimaytac/hashspan/pull/147) [`a777da8`](https://github.com/selimaytac/hashspan/commit/a777da8ecfe81d9e8221037271dcee07642d4023) Thanks [@selimaytac](https://github.com/selimaytac)! - `traceTransport(transport, options?)` wraps a viem transport so that each JSON-RPC request becomes a client span
  named after its method, with the OpenTelemetry RPC attributes, the server's host and port and the chain id, and no
  parameters, results or URL path (ADR 0019). With `withHashspan()`, the requests of a transaction nest under its send
  span. `methods` selects the methods to trace.

### Patch Changes

- Updated dependencies [[`3fbc570`](https://github.com/selimaytac/hashspan/commit/3fbc57094efd99dd218aadb5e1d72f15bbbd4d8c)]:
  - @hashspan/core@0.7.0

## 0.6.0

### Minor Changes

- [#133](https://github.com/selimaytac/hashspan/pull/133) [`c898941`](https://github.com/selimaytac/hashspan/commit/c898941305240ee1b13513d0f9de14ccf984c47d) Thanks [@selimaytac](https://github.com/selimaytac)! - `watch()` takes an `onReceipt` callback, called once when the watch ends: with the receipt of the mined transaction,
  logs included, or with `undefined` when no receipt was retrieved. It never affects the confirm span; the x402
  adapter uses it to check that a settlement transaction carries the payment (ADR 0017).

### Patch Changes

- [#142](https://github.com/selimaytac/hashspan/pull/142) [`071730f`](https://github.com/selimaytac/hashspan/commit/071730f525c7f9446b5591dd3ba3b72e6bd34780) Thanks [@selimaytac](https://github.com/selimaytac)! - A call whose arguments throw when telemetry reads them, such as a Proxy whose `getOwnPropertyDescriptor` or
  `ownKeys` trap throws, or a revoked Proxy, is now made untraced with its original arguments instead of rejecting.
  The base action runs once, and its result or error reaches the caller unchanged.
- Updated dependencies [[`7ba73bb`](https://github.com/selimaytac/hashspan/commit/7ba73bb2e2a87c157c2819d23b66b6266925472a)]:
  - @hashspan/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`2c2ddb6`](https://github.com/selimaytac/hashspan/commit/2c2ddb61321580b0dcca205faef5e9a6a15ca43b), [`7ca4af6`](https://github.com/selimaytac/hashspan/commit/7ca4af6541f09ede2e328cd15eaee2e530a6a48c)]:
  - @hashspan/core@0.5.0

## 0.4.0

### Minor Changes

- [#109](https://github.com/selimaytac/hashspan/pull/109) [`c92f9e3`](https://github.com/selimaytac/hashspan/commit/c92f9e3b15582d6251d6500b90b79d86bd7be2be) Thanks [@selimaytac](https://github.com/selimaytac)! - `sendTransaction` and `writeContract` now run while their send span is the active span, so spans that wallet, RPC or
  HTTP instrumentation creates for the call nest under the send span instead of beside it (ADR 0015). Background
  confirmations and the code after the call stay under the caller. Sends of clients without a chain are recorded after
  the call and do not nest; with a tracker from `@hashspan/core` before 0.4, the call runs in the caller's context as
  before.

### Patch Changes

- [#108](https://github.com/selimaytac/hashspan/pull/108) [`3a382f2`](https://github.com/selimaytac/hashspan/commit/3a382f26724fc3847359df9da6773b7de0706ed1) Thanks [@selimaytac](https://github.com/selimaytac)! - `waitForTransactionReceipt` keeps every option when another extension applied before `withHashspan()` copies its
  arguments with a spread. Since 0.3.2 only `onReplaced` was an own property of the options the adapter passed on, so
  such a copy lost `hash`, `timeout` and `confirmations`.
- Updated dependencies [[`c20d91d`](https://github.com/selimaytac/hashspan/commit/c20d91da7ec552fc9d6a6d50c62b8eb4b3a2412f), [`15f16ba`](https://github.com/selimaytac/hashspan/commit/15f16bac79dc5dc13506a224fdea9c4abf5d0a34), [`990a2ea`](https://github.com/selimaytac/hashspan/commit/990a2ea75536f6451923bbb51d1f4684aee48b3d), [`2f424f2`](https://github.com/selimaytac/hashspan/commit/2f424f2896d66d7d6b32e448b5643c81f0bee1a2), [`905d2f8`](https://github.com/selimaytac/hashspan/commit/905d2f859b1130657ab92d11dcb90bae86e7517e)]:
  - @hashspan/core@0.4.0

## 0.3.2

### Patch Changes

- [#79](https://github.com/selimaytac/hashspan/pull/79) [`1051084`](https://github.com/selimaytac/hashspan/commit/1051084da16520ce00d337457e4c8823f0ff70ec) Thanks [@selimaytac](https://github.com/selimaytac)! - Tracing `writeContract` no longer runs getters inside the ABI. To find the function selector and to decode revert
  reasons, the adapter now uses a copy of the needed ABI items (the called function's overloads and the errors) made
  of own data properties only, so an ABI built at runtime with accessors encodes the same call as without tracing.

- [#78](https://github.com/selimaytac/hashspan/pull/78) [`6cf7e8a`](https://github.com/selimaytac/hashspan/commit/6cf7e8ad87de0789c1093b38b746c984b4efc15b) Thanks [@selimaytac](https://github.com/selimaytac)! - A traced `waitForTransactionReceipt` behaves like viem's own with any options object: frozen options no longer throw
  "Cannot redefine property: onReplaced", and an `onReplaced` callback inherited from a prototype is called again.
  The adapter now passes viem an object whose prototype is the caller's options instead of a copy.

## 0.3.1

### Patch Changes

- [#72](https://github.com/selimaytac/hashspan/pull/72) [`f8828e3`](https://github.com/selimaytac/hashspan/commit/f8828e331f8dd4a1684a97ec87be254bf9de2010) Thanks [@selimaytac](https://github.com/selimaytac)! - Tracing no longer runs getters on call arguments. The adapters read the fields they record (such as `to`, `value`,
  `network` or a transaction's fields) only from own data properties, so a getter with side effects, or one that
  returns a different value per read, now sees the same reads as without tracing; a field behind a getter is left out
  of the span. A `waitForTransactionReceipt` call whose `hash` or `onReplaced` is a getter is passed on untraced.

- [#73](https://github.com/selimaytac/hashspan/pull/73) [`d8748f9`](https://github.com/selimaytac/hashspan/commit/d8748f90964eaa5ec643de9fb4d409e6c47bda0c) Thanks [@selimaytac](https://github.com/selimaytac)! - `watch()` records nothing, with a `diag` warning, when its `chainId` option contradicts the chain of the client it
  was given, instead of polling that client and ending the confirm span as a timeout for the wrong chain.

## 0.3.0

### Minor Changes

- [#57](https://github.com/selimaytac/hashspan/pull/57) [`7b99e7b`](https://github.com/selimaytac/hashspan/commit/7b99e7becae4a4f8d6b1416fc9c0df5ff85f64ce) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `watch(client, { hash, chainId?, timeoutMs?, abi? })` to the `withHashspan()` result: it confirms a transaction
  sent outside the extended clients, such as by a wallet API, in the background, with the receipt, revert reason and
  fees, linked to a send span recorded by the same tracker.

### Patch Changes

- [#66](https://github.com/selimaytac/hashspan/pull/66) [`081cab2`](https://github.com/selimaytac/hashspan/commit/081cab2158d8a1e12e76f7abd386e28a79f5b0ff) Thanks [@selimaytac](https://github.com/selimaytac)! - Background confirmation and `watch()` no longer end the confirm span with `TransactionReceiptNotFoundError` when a
  node returns the mined transaction before its receipt: they wait again until their timeout. The result of your own
  `waitForTransactionReceipt` calls is unchanged.
- Updated dependencies [[`28a83c2`](https://github.com/selimaytac/hashspan/commit/28a83c265f11836a5eca26a99971daa402abc4d3)]:
  - @hashspan/core@0.3.0

## 0.2.0

### Minor Changes

- [#50](https://github.com/selimaytac/hashspan/pull/50) [`6da02c7`](https://github.com/selimaytac/hashspan/commit/6da02c74d872a05e04f496cc10fcc9a04fb43c6c) Thanks [@selimaytac](https://github.com/selimaytac)! - A field set in the static `agent` option now always wins over the Baggage entries `gen_ai.agent.id` /
  `gen_ai.agent.name`; Baggage only fills fields the option leaves unset. The new `agentFromBaggage: false` option stops
  reading agent identity from Baggage, for services that accept requests from outside their trust boundary, where a
  caller could otherwise attribute transactions to another agent.

- [#45](https://github.com/selimaytac/hashspan/pull/45) [`7dc19d1`](https://github.com/selimaytac/hashspan/commit/7dc19d16f72e0c1ed8308ecfa006afacc3989c48) Thanks [@selimaytac](https://github.com/selimaytac)! - Require Node.js 22.3 or later (`engines`). Node.js 18 and 20 have reached end of life, and `hashed` address mode relies
  on `process.getBuiltinModule`, available from Node.js 22.3; the packages are built for that target.

### Patch Changes

- Updated dependencies [[`6da02c7`](https://github.com/selimaytac/hashspan/commit/6da02c74d872a05e04f496cc10fcc9a04fb43c6c), [`7dc19d1`](https://github.com/selimaytac/hashspan/commit/7dc19d16f72e0c1ed8308ecfa006afacc3989c48)]:
  - @hashspan/core@0.2.0

## 0.1.0

### Minor Changes

- [#3](https://github.com/selimaytac/hashspan/pull/3) [`9906585`](https://github.com/selimaytac/hashspan/commit/9906585595be8ac4ae2ac327ffc21affb5a10d11) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `confirm: { mode: 'background' }` to `withHashspan()`: sent transactions are confirmed without an explicit wait
  and without delaying the send. The background confirmation polls independently of the caller's own
  `waitForTransactionReceipt`, whose options (timeout, `confirmations`) are left untouched.

- [#10](https://github.com/selimaytac/hashspan/pull/10) [`09923bd`](https://github.com/selimaytac/hashspan/commit/09923bd42a27ba5ad1417185278ec4670b6d693a) Thanks [@selimaytac](https://github.com/selimaytac)! - Attribute receipts of replaced transactions to the transaction that was mined. `ReceiptLike` accepts optional
  `transactionHash` and `replacementReason`; when the hash differs from the awaited one, the awaited transaction's
  confirm span ends with `blockchain.tx.status = replaced`, `blockchain.tx.replacement.hash` and
  `blockchain.tx.replacement.reason`, and the receipt is recorded on the confirm span of the mined transaction. The
  viem adapter reports replacements from `onReplaced`, keeps the caller's callback and result unchanged, and decodes the
  revert reason of a replacing call to the same contract with the original ABI.

- [#4](https://github.com/selimaytac/hashspan/pull/4) [`de9a101`](https://github.com/selimaytac/hashspan/commit/de9a101b9c293aa83447584b9329359a8134b3e5) Thanks [@selimaytac](https://github.com/selimaytac)! - Record the revert reason of reverted transactions by replaying them on the previous block's state, including custom
  errors for transactions sent with `writeContract`. The replay is bounded (10 s by default,
  `decodeRevertReason: { timeoutMs }`), so an unresponsive provider cannot keep the confirm span open. Opt out with
  `decodeRevertReason: false`.

- [#2](https://github.com/selimaytac/hashspan/pull/2) [`5dc76ea`](https://github.com/selimaytac/hashspan/commit/5dc76ea8d14fe1ae36cb9448ede27a455fee8406) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `withHashspan()`, a viem client extension that traces `sendTransaction` and `writeContract` as `send` spans and
  `waitForTransactionReceipt` as linked `confirm` spans with `@hashspan/core`.
  
  - no telemetry work runs before the traced call: for clients without a chain, the chain id is requested alongside
    the call on every call, so spans follow a wallet that switches networks; a call whose chain id is still unknown
    30 s after it ended is not traced
  - every call into the tracker is guarded, so tracing never changes the result or the error of a traced call
  - `writeContract` arguments are passed to the tracker, which records them with `recordFunctionArguments: true`
  - `flush({ timeoutMs })` on the `withHashspan()` result waits for spans that end after the traced call returned,
    keeps the process alive while waiting and ends whatever it cannot wait for as `timeout`,
    for use before shutting the OpenTelemetry SDK down
  - `diag` logs only error names

### Patch Changes

- Updated dependencies [[`4059847`](https://github.com/selimaytac/hashspan/commit/405984785d2bba6a1887195388d3082b63a3a7e2), [`09923bd`](https://github.com/selimaytac/hashspan/commit/09923bd42a27ba5ad1417185278ec4670b6d693a)]:
  - @hashspan/core@0.1.0
