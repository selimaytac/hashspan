# 0007. Confirmation ownership and concurrent waits

- Status: proposed
- Date: 2026-09-27

## Context

Several waits can observe the same transaction: a background confirmation and the caller's own
`waitForTransactionReceipt`, waits on a wallet client and on a public client, or retries. Each transaction should
get exactly one confirm span for its outcome.

Deduplication currently lives in the viem adapter, in a registry created per `withHashspan()` call. It has three
gaps:

- Two `withHashspan()` results that share one `tracker` have separate registries, so one transaction gets two
  confirm spans.
- The second wait never gets a handle. If the first wait fails or times out and releases its claim, a later success
  of the second wait is not recorded.
- Every future adapter would have to reimplement the same rules.

## Decision

**The tracker owns confirmations.** Each tracker keeps a bounded, time-limited registry keyed by chain id and
lower-cased hash. `startConfirm` is idempotent per key: every call returns its own handle, and handles for the
same key join one confirm span. No handle methods are added.

**Span.** The first handle creates the span. Its parent and start time follow the existing rules (docs/semconv.md)
for that first call. Handles that join later do not change the parent, links or start time.

**Outcome.**

- A receipt from any handle ends the span. The first receipt wins; later calls on any handle for that span are
  ignored.
- `timeout()` and `fail()` only withdraw their handle. The span ends with the outcome of the last handle to
  withdraw, at the time it withdraws, if no receipt arrived. Its duration therefore covers the longest wait.
- Calls on a handle after it withdrew, or after its span ended, are ignored and have no side effects; in
  particular a late receipt of a replacing transaction does not trigger ADR 0008 again.

**After the span ends.**

- Receipt, or replaced by another transaction (ADR 0008): the key stays settled for the link TTL (default 10
  minutes). `startConfirm` for a settled key returns a no-op handle, so a late or repeated wait adds no span.
- Timeout or failure: the key is released, so a retry gets a new confirm span.

**Adapters** stop keeping their own registry. They call `startConfirm` for every wait they trace and report the
outcome of that wait. Background confirmation is simply one more handle. Work that should run once per
transaction, such as fetching a revert reason, is shared per key within the adapter (one in-flight request per
key), so concurrent waits do not duplicate RPC requests.

**Bounds.** The registry uses the same limits as the send links (`linkTtlMs`, `maxTrackedTransactions`). An evicted
in-flight entry keeps its span and its handles still end it, but a new `startConfirm` for that key starts a
second span. This is the one exception to the single-span guarantee; it only occurs when more than
`maxTrackedTransactions` transactions are tracked at once.

**Alternative considered.** Keying the adapter's registry by tracker (`WeakMap<TxTracker, ...>`) closes the first
gap with less change, but leaves the other two and duplicates the rules in every adapter.

## Consequences

- One confirm span per transaction and tracker, however many clients, extensions or waits observe it, as long as
  the registry has not evicted the in-flight entry (see *Bounds*).
- A success is never lost because another wait gave up first.
- `startConfirm` changes from "always a new span" to "join or create". Callers that relied on one span per call must
  use separate trackers. This is a behaviour change of the core API and needs a changeset.
- The confirm span parent rule gains one sentence: the first wait determines the parent.
- A handle that is never ended keeps the shared span open, even after every other handle withdrew. Adapter
  handles always end; direct users of the core must end every handle they start.
- Replacement handling (ADR 0008) builds on this registry.
