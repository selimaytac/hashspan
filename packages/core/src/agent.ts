import { type Attributes, type Context, propagation } from '@opentelemetry/api';
import type { AgentIdentity } from './types.js';

export const ATTR_GEN_AI_AGENT_ID = 'gen_ai.agent.id' as const;
export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name' as const;

/**
 * Agent identity as GenAI attributes. A field set in the static identity always wins; Baggage, which a remote caller
 * can set, only fills fields it leaves unset, and is not read at all with `fromBaggage` false
 * (https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.9.0/docs/adr/0011-agent-identity-precedence.md).
 */
export function agentAttributes(
  ctx: Context,
  identity: AgentIdentity | undefined,
  fromBaggage = true,
): Attributes {
  const baggage = fromBaggage ? propagation.getBaggage(ctx) : undefined;
  const id = identity?.id ?? baggage?.getEntry(ATTR_GEN_AI_AGENT_ID)?.value;
  const name = identity?.name ?? baggage?.getEntry(ATTR_GEN_AI_AGENT_NAME)?.value;
  const attributes: Attributes = {};
  if (id !== undefined) attributes[ATTR_GEN_AI_AGENT_ID] = id;
  if (name !== undefined) attributes[ATTR_GEN_AI_AGENT_NAME] = name;
  return attributes;
}
