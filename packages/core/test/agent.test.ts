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

  it('prefers the static identity over baggage (ADR 0011)', () => {
    const ctx = withBaggage({ 'gen_ai.agent.id': 'from-baggage', 'gen_ai.agent.name': 'impostor' });
    expect(agentAttributes(ctx, { id: 'static', name: 'treasury' })).toEqual({
      'gen_ai.agent.id': 'static',
      'gen_ai.agent.name': 'treasury',
    });
  });

  it('fills fields the static identity leaves unset from baggage', () => {
    const ctx = withBaggage({ 'gen_ai.agent.id': 'run-42', 'gen_ai.agent.name': 'impostor' });
    expect(agentAttributes(ctx, { name: 'treasury' })).toEqual({
      'gen_ai.agent.id': 'run-42',
      'gen_ai.agent.name': 'treasury',
    });
  });

  it('ignores baggage when reading identity from it is turned off', () => {
    const ctx = withBaggage({ 'gen_ai.agent.id': 'run-42', 'gen_ai.agent.name': 'impostor' });
    expect(agentAttributes(ctx, { name: 'treasury' }, false)).toEqual({
      'gen_ai.agent.name': 'treasury',
    });
    expect(agentAttributes(ctx, undefined, false)).toEqual({});
  });
});
