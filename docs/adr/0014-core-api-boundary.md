# 0014. Core API boundary before 1.0

- Status: proposed
- Date: 2026-10-01

## Context

The core's API has to be able to grow before 1.0 without a major release each time. Three things stand in the way:

- **`TxTracker` and its handles are interfaces anyone can implement.** Adding a member, as `startPayment` did
  (ADR 0013), breaks every hand-written tracker at compile time. Such a tracker also loses what the core guarantees:
  one confirm span per transaction (ADR 0007), attribution of replaced transactions (ADR 0008), the privacy modes
  (ADR 0004) and never throwing. Sharing a tracker between adapters and testing need no custom tracker:
  `createTxTracker()` covers both, and the redaction hook or a span processor changes what spans record.
- **Handle methods take positional arguments**, e.g. `end(hash, endTime)` and `fail(error, endTime, options)`.
  Every new field needs a new position.
- **Transactions are identified by `(chainId: number, hash)`**, an EIP-155 chain id and a `0x` hash. Other
  identifiers (CAIP-2 networks, user operation hashes) will need room in the API.

Adapters depend on the core as `^0.x`, which in 0.x covers a single minor. An application can therefore hold two
copies of the core, and a tracker shared between adapters can come from an older copy than an adapter expects.

## Decision

- **`TxTracker` and its handles are produced by `createTxTracker()` only.** They are not meant to be implemented
  outside the core, and members may be added to them, and to their handles, in minor releases. This is a documented
  policy, not a type-level brand: a `unique symbol` brand would make two copies of the core, or its `.d.mts` and
  `.d.cts` declarations, incompatible with each other, so a tracker could no longer be shared between adapters.
- **Adapters detect members added after the oldest core they accept** and record nothing for them when a tracker
  lacks them, as `@hashspan/viem`'s tracker guard does for `startPayment`. They keep guarding every call into a
  tracker at runtime, since JavaScript callers can pass anything.
- **Handle methods take what happened first and an options object second**, e.g. `end({ hash }, { endTime })` and
  `fail(error, { endTime, errorType })`. The error stays a separate first argument, since a thrown value can be any
  object and could not be told apart from options. The positional forms keep working, deprecated, until 1.0.
- **New identifiers arrive as optional fields** on input and result objects, such as a CAIP-2 network next to
  `chainId`. `chainId` stays the EIP-155 chain id, recorded as `blockchain.chain.id`.

## Consequences

- Adding tracker or handle members is a minor change. A hand-written tracker stops type-checking when one is added
  (first with `startPayment` in core 0.4.0); the fix is to use `createTxTracker()`.
- ADR 0008's note that user-implemented trackers keep working no longer holds as a guarantee.
- Handle methods accept two argument forms until 1.0, which the core tells apart at runtime without throwing.
- The extension rule for identifiers holds only because callers never implement the inputs' consumer: the tracker
  reads new optional fields, and existing callers simply do not set them.
