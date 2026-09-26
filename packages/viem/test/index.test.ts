import { expect, it } from 'vitest';
import { ADAPTER_NAME } from '../src/index.js';

it('exposes the adapter name', () => {
  expect(ADAPTER_NAME).toBe('@hashspan/viem');
});
