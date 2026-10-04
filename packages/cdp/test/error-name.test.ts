import { describe, expect, it } from 'vitest';
import { errorName } from '../src/helpers.js';

const symbolNamed = (): Error => {
  const error = new Error('boom');
  Object.defineProperty(error, 'name', { value: Symbol('name') });
  return error;
};
const getterNamed = (): Error => {
  const error = new Error('boom');
  Object.defineProperty(error, 'name', {
    get() {
      throw new Error('name');
    },
  });
  return error;
};
const textNamed = (name: string): Error => {
  const error = new Error('boom');
  error.name = name;
  return error;
};

describe('errorName', () => {
  it('gives short text for any error, so a diag message can always include it', () => {
    expect(errorName(textNamed('APIError'))).toBe('APIError');
    for (const error of [symbolNamed(), getterNamed(), textNamed('x'.repeat(65)), 'thrown']) {
      expect(errorName(error)).toBe('unknown error');
    }
  });
});
