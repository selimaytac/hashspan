# 0025. Untrusted input: what telemetry reads, and its bounds

- Status: proposed
- Date: 2026-10-03

## Context

hashspan records data that it does not control, inside the process of the application it observes. Security passes
over 0.8 and 0.9 kept finding the same few kinds of bug:

- a value cut to a length bound that split an address, so the address mode no longer recognised it (#252);
- a URL with an API key in a recorded error message (#253);
- a chain id taken from a remote party without checking it against the client (#254);
- a list read in full on the caller's path before the core kept 64 entries (#255);
- a name lookup that matched `Object.prototype` members (#249);
- state that unauthenticated callers decide, without a bound (ADR 0023, payee payments).

The advisories of OpenTelemetry JS fall into the same classes: an uncaught exception on malformed input, unbounded
allocation, and sensitive data recorded by default. The SDK does not bound attribute values by default
(`AttributeValueLengthLimit` is unlimited unless configured), so an instrumentation has to bound what it records.

Each fix so far was local. Without a stated rule, the next send path or adapter can repeat any of them, and a review
has nothing to check against.

## Decision

**Untrusted sources.** Everything telemetry reads from the following is untrusted, whatever its declared type:

- responses of remote parties: RPC nodes (receipts, logs, chain ids, errors), bundlers, wallets (EIP-5792 status),
  the CDP API, x402 servers and facilitators;
- the caller's arguments, which may be Proxies, carry getters or be frozen, sparse or very large;
- a tracker the caller passes in (the `tracker` option), and options in general;
- error objects and their messages, from any of the above.

**Rules.** Code that reads an untrusted source:

1. **Never throws into the caller and never changes its result.** Reading is guarded; a failure leaves the call
   untraced or the span ended with `error.type` `_OTHER`, and is logged through `diag` (as today).
2. **Reads own data properties only,** so no getter of the caller's runs; lookups by a name from such a source use
   `Object.hasOwn` or a `Map`.
3. **Validates before recording:** addresses as 20-byte hex, hashes as 32-byte hex, quantities as non-negative
   integers, chain ids as positive safe integers, identifiers against a short pattern; a value that fails is not
   recorded.
4. **Bounds what it reads and what it records:** strings by length (cut so that no hex value is split), lists by
   count (reading at most the bound, while a count attribute may report the full length), nesting by depth, and state
   kept across calls by a number of entries with an eviction rule. Each bound is a named constant next to the code.
5. **Keeps metric attributes to closed sets:** chain id, system, outcome from a fixed list, `error.type` as a short
   identifier or `_OTHER`; never an address, hash, URL or message.
6. **Records sensitive data only on opt-in:** function arguments and raw error messages stay opt-in; addresses follow
   the address mode; URLs are cut to their origin unless the user asks for more.

**Enforcement.** A shared table of hostile inputs (throwing Proxy traps, accessors, prototype names, huge and sparse
arrays, values that split at a bound, long strings, malformed hex, out-of-range numbers) runs against every public
entry point of the four packages in the unit tests, so CI checks the rules instead of review alone. New entry points
are added to the table in the same pull request. OpenSSF Scorecard and a workflow linter (zizmor) run in CI for the
repository itself.

## Consequences

- A new send path or adapter has a checklist; a review can point at a rule number.
- The existing bounds (revert reasons 1024 characters, sanitized messages 256, function arguments 4096 characters and
  depth 32, at most 64 authorizations and 64 call batch hashes, 1000 open x402 payments) are kept and listed in one
  table in docs/semconv.md, so users know what a long value turns into.
- The hostile-input table adds test time and some upkeep when an entry point changes.
- Out of scope: the security of the user's own exporter, collector and backend, and of the instrumented libraries
  themselves; vulnerabilities are reported per SECURITY.md.

## Amendment (2026-10-18, proposed): values a remote party chooses

Rule 6 says addresses follow the address mode. It was applied to fields that hold an address, and to `0x` hex inside
free text. A value that a remote party chooses can carry an address in other forms: an identifier such as an x402
scheme, an MPP method or a facilitator's failure reason accepts `0x` followed by 40 hex characters as a short
identifier, and a resource host, an error type or an id can hold the 40 characters without `0x`. In `hashed` and `off`
mode, such a value put the address into the backend as it is. Only `mpp.challenge.id` checked for this
([ADR 0029](0029-mpp-payments.md)).

- In `hashed` and `off` address mode, a value a remote party chooses that is not itself an address is not recorded
  when it holds 40 hex characters in a row, with or without `0x`. One check in the core applies it to the payment
  protocol, `x402.scheme`, `mpp.method`, `mpp.intent`, `mpp.challenge.id`, `blockchain.call_batch.id` (the wallet
  chooses it) and the agent id and name taken from Baggage (an upstream caller sets them).
- `x402.resource`, `mpp.resource`, `error.type` and `exception.type` keep formatting a `0x` address by the address
  mode. What still holds 40 hex characters in a row after that is not recorded; an error type becomes `_OTHER`.
- A call batch id is usually 32 bytes of hex or longer, so in these modes the attribute is rarely recorded. The id
  still keys the batch, so its confirm span links to its send span as before.
- `raw` mode is unchanged, and so is the static `agent` option, which is the user's own text.
- The hostile-input table has rows with an address, an address without `0x` and one inside other text for each of
  these fields. The rule is stated once in docs/semconv.md, under "Values a remote party chooses".
