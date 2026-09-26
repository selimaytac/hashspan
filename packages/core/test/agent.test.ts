import { propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { agentAttributes } from '../src/agent.js';

const withBaggage = (entries: Record<string, string>) =>
  propagation.setBaggage(
    ROOT_CONTEXT,
    propagation.createBaggage(
      Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { value: v }])),
    ),
  );

describe('agentAttributes', () => {
  it('returns nothing when no identity is known', () => {
    expect(agentAttributes(ROOT_CONTEXT, undefined)).toEqual({});
  });

  it('uses the static identity as a fallback', () => {
    expect(agentAttributes(ROOT_CONTEXT, { id: 'agent-1', name: 'treasury' })).toEqual({
      'gen_ai.agent.id': 'agent-1',
      'gen_ai.agent.name': 'treasury',
    });
  });

  it('prefers baggage over the static identity', () => {
    const ctx = withBaggage({ 'gen_ai.agent.id': 'from-baggage' });
    expect(agentAttributes(ctx, { id: 'static', name: 'treasury' })).toEqual({
      'gen_ai.agent.id': 'from-baggage',
      'gen_ai.agent.name': 'treasury',
    });
  });
});
