import { type Attributes, type Context, propagation } from '@opentelemetry/api';
import type { AgentIdentity } from './types.js';

/** Agent id of the GenAI conventions, from the tracker's `agent` option or Baggage; on every span. */
export const ATTR_GEN_AI_AGENT_ID = 'gen_ai.agent.id' as const;
/** Agent name of the GenAI conventions, from the tracker's `agent` option or Baggage; on every span. */
export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name' as const;

/**
 * Agent identity as GenAI attributes. A field set in the static identity always wins; Baggage, which a remote caller
 * can set, only fills fields it leaves unset, and is not read at all with `fromBaggage` false
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@1.1.0/docs/adr/0011-agent-identity-precedence.md).
 */
export function agentAttributes(
  ctx: Context,
  identity: AgentIdentity | undefined,
  fromBaggage = true,
): Attributes {
  const baggage = fromBaggage ? propagation.getBaggage(ctx) : undefined;
  const id = identity?.id ?? fromRemote(baggage?.getEntry(ATTR_GEN_AI_AGENT_ID)?.value);
  const name = identity?.name ?? fromRemote(baggage?.getEntry(ATTR_GEN_AI_AGENT_NAME)?.value);
  const attributes: Attributes = {};
  if (id !== undefined) attributes[ATTR_GEN_AI_AGENT_ID] = id;
  if (name !== undefined) attributes[ATTR_GEN_AI_AGENT_NAME] = name;
  return attributes;
}

/** Letters, digits, spaces and `_ . : @ / -`, at most 128 characters: what an agent id or name needs. */
const REMOTE_AGENT_VALUE = /^[\p{L}\p{N} _.:@/-]{1,128}$/u;

/** A Baggage value, which a remote caller sets, if it looks like an agent id or name (ADR 0025 rule 3). */
function fromRemote(value: string | undefined): string | undefined {
  return value !== undefined && REMOTE_AGENT_VALUE.test(value) ? value : undefined;
}
