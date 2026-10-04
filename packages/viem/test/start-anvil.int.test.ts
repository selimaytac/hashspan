import { afterAll, expect, it } from 'vitest';
import { type StartedAnvil, startAnvil } from './start-anvil.js';

const binary = new URL('../../../.tools/bin/anvil', import.meta.url).pathname;
const started: StartedAnvil[] = [];

afterAll(async () => {
  await Promise.all(started.map(({ instance }) => instance.stop()));
});

// #324: a port asked for before Anvil bound it could be taken in between; with port 0 the OS assigns it as Anvil binds.
it('starts several Anvils at once, each answering on its own port', async () => {
  started.push(...(await Promise.all(Array.from({ length: 4 }, () => startAnvil({ binary })))));

  const ports = started.map(({ port }) => port);
  expect(new Set(ports).size).toBe(ports.length);
  for (const { rpcUrl } of started) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
    });
    expect(await response.json()).toMatchObject({ result: '0x7a69' });
  }
});
