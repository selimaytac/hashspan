---
"@hashspan/core": minor
"@hashspan/viem": minor
---

A field set in the static `agent` option now always wins over the Baggage entries `gen_ai.agent.id` /
`gen_ai.agent.name`; Baggage only fills fields the option leaves unset. The new `agentFromBaggage: false` option stops
reading agent identity from Baggage, for services that accept requests from outside their trust boundary, where a
caller could otherwise attribute transactions to another agent.
