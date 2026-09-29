# 0011. Agent identity precedence

- Status: proposed
- Date: 2026-09-29

## Context

Transaction spans carry `gen_ai.agent.id` and `gen_ai.agent.name`, taken from OpenTelemetry Baggage entries with the
same keys, or from the tracker's static `agent` option. Baggage has taken precedence so far.

Baggage travels with requests between services (the W3C `baggage` header). A service that accepts requests from
outside its trust boundary can therefore receive identity entries set by a caller, and a caller can attribute
transactions, and their cost, to an agent of its choosing. An identity the operator configured explicitly should not
be overridable that way.

## Decision

- **Static identity first.** A field set in the `agent` option (`id`, `name`) is always used. Baggage only fills
  fields the option leaves unset. This keeps the common setup working, where a service names its agent statically
  and a per-run id travels in Baggage.
- **Baggage can be ignored.** A new tracker option `agentFromBaggage` (default `true`) turns reading identity from
  Baggage off. Services that receive requests from outside their trust boundary should set it to `false`.
- The viem adapter passes both options through, as it does for every tracker option.
- 0.x minor release with a changeset, since spans can change for setups that set both a static field and the same
  field in Baggage.

## Consequences

- An operator's configured identity cannot be replaced by an inbound request.
- A static `agent.id` now also wins over a Baggage id set by the application itself; applications that relied on
  per-run ids overriding a static id should drop `agent.id` from the option.
- With `agentFromBaggage: false`, identity comes from the option only; Baggage stays untouched for other consumers.
