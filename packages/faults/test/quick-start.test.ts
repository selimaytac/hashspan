// Runs the README's quick start (test/readme/quick-start.ts) as written, against a local stand-in for the node.
import { createServer } from 'node:http';
import { afterAll, expect, it, vi } from 'vitest';

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const { id } = JSON.parse(body) as { id: unknown };
    blocks += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result: `0x${blocks.toString(16)}` }));
  });
});
let blocks = 0;
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

it('runs the README quick start', async () => {
  const address = server.address();
  process.env.FAULTS_QUICK_START_NODE = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await import('./readme/quick-start.js');
  expect(log.mock.calls).toEqual([
    ['block', 1n],
    ['failed', 'HttpRequestError'],
    ['block', 2n],
    [{ eth_blockNumber: 3 }],
  ]);
  // The rate-limited request never reached the node.
  expect(blocks).toBe(2);
  log.mockRestore();
});
