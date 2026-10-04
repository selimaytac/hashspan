import { describe, expect, it } from 'vitest';
import { listeningPort } from './start-anvil.js';

const BANNER =
  '\n\n    1.8.3 (cae51ad458 2026-09-15T10:34:23.361078000Z)\n    https://github.com/foundry-rs/foundry\n\n';

describe('reading the port from what Anvil printed', () => {
  it('reads it from the "Listening on" line after the banner', () => {
    expect(listeningPort(`${BANNER}Listening on 127.0.0.1:49188\n`)).toBe(49188);
  });

  it('reads it with an IPv6 host and a Windows line end', () => {
    expect(listeningPort('Listening on [::1]:8545\r\n')).toBe(8545);
  });

  it('waits for the end of the line, so a port cut between two chunks is not read short', () => {
    expect(listeningPort(`${BANNER}Listening on 127.0.0.1:491`)).toBeUndefined();
    expect(listeningPort(`${BANNER}Listening on 127.0.0.1:491` + '88\n')).toBe(49188);
  });

  it('finds no port before the line', () => {
    expect(listeningPort(BANNER)).toBeUndefined();
  });
});
