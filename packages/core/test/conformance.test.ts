import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import {
  ATTR_BLOCKCHAIN_TX_HASH,
  ATTR_BLOCKCHAIN_TX_STATUS,
  BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
  BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
  METRIC_BLOCKCHAIN_CLIENT_FEE,
} from '../src/index.js';
import { assertConformant, CONTRACT, metricViolations, spanViolations } from './conformance.js';

const span = (attributes: Attributes, events: { name: string; attributes?: Attributes }[] = []) =>
  ({ name: 'confirm 1', attributes, events }) as unknown as ReadableSpan;

describe('the conformance check', () => {
  it('reads the semantic conventions from the exports of the core', () => {
    expect(CONTRACT.attributes.has(ATTR_BLOCKCHAIN_TX_HASH)).toBe(true);
    expect(CONTRACT.metrics.has(METRIC_BLOCKCHAIN_CLIENT_FEE)).toBe(true);
    expect(CONTRACT.values.get(ATTR_BLOCKCHAIN_TX_STATUS)).toContain(
      BLOCKCHAIN_TX_STATUS_VALUE_REPLACED,
    );
  });

  it('accepts documented attributes and values, and attributes of namespaces hashspan does not own', () => {
    expect(
      spanViolations([
        span({
          [ATTR_BLOCKCHAIN_TX_HASH]: `0x${'ab'.repeat(32)}`,
          [ATTR_BLOCKCHAIN_TX_STATUS]: BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS,
          'error.type': 'TimeoutError',
          'gen_ai.tool.name': 'pay',
        }),
      ]),
    ).toEqual([]);
  });

  it('reports an attribute of an owned namespace that is not documented, on a span or an event', () => {
    expect(
      spanViolations([
        span({ 'blockchain.tx.extra': 1 }, [
          { name: 'exception', attributes: { 'x402.unknown': 'a' } },
        ]),
      ]),
    ).toEqual([
      'span "confirm 1": blockchain.tx.extra is not in the semantic conventions',
      'span "confirm 1" event exception: x402.unknown is not in the semantic conventions',
    ]);
  });

  it('reports a value outside the closed set of its attribute', () => {
    const [violation] = spanViolations([span({ [ATTR_BLOCKCHAIN_TX_STATUS]: 'dropped' })]);
    expect(violation).toMatch(
      /^span "confirm 1": blockchain\.tx\.status is "dropped", not one of /,
    );
    expect(() => assertConformant([span({ [ATTR_BLOCKCHAIN_TX_STATUS]: 'dropped' })])).toThrow(
      'recorded outside the semantic conventions',
    );
  });

  it('reports an unknown metric, label or label value', () => {
    expect(
      metricViolations([
        { name: METRIC_BLOCKCHAIN_CLIENT_FEE, attributes: { 'blockchain.chain.id': 1 } },
        { name: 'blockchain.client.other', attributes: {} },
        { name: METRIC_BLOCKCHAIN_CLIENT_FEE, attributes: { 'blockchain.wallet': 'x' } },
        {
          name: METRIC_BLOCKCHAIN_CLIENT_FEE,
          attributes: { [ATTR_BLOCKCHAIN_TX_STATUS]: 'dropped' },
        },
      ]),
    ).toEqual([
      'metric blockchain.client.other is not in the semantic conventions',
      'metric blockchain.client.fee: blockchain.wallet is not in the semantic conventions',
      expect.stringMatching(/^metric blockchain\.client\.fee: blockchain\.tx\.status is "dropped"/),
    ]);
  });
});
