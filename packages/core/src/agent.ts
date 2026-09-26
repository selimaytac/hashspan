import { type Attributes, type Context, propagation } from '@opentelemetry/api';
import type { AgentIdentity } from './types.js';

export const ATTR_GEN_AI_AGENT_ID = 'gen_ai.agent.id' as const;
export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name' as const;

/** Agent identity from baggage (preferred) or the static fallback, as GenAI attributes. */
export function agentAttributes(ctx: Context, fallback: AgentIdentity | undefined): Attributes {
  const baggage = propagation.getBaggage(ctx);
  const id = baggage?.getEntry(ATTR_GEN_AI_AGENT_ID)?.value ?? fallback?.id;
  const name = baggage?.getEntry(ATTR_GEN_AI_AGENT_NAME)?.value ?? fallback?.name;
  const attributes: Attributes = {};
  if (id !== undefined) attributes[ATTR_GEN_AI_AGENT_ID] = id;
  if (name !== undefined) attributes[ATTR_GEN_AI_AGENT_NAME] = name;
  return attributes;
}
