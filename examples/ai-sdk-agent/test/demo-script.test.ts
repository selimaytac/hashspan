import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/demo.sh', import.meta.url));

interface Run {
  code: number;
  stderr: string;
  ms: number;
}

const run = (env: Record<string, string>): Promise<Run> => {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script],
      { env: { ...process.env, ...env }, timeout: 20_000 },
      (error, _out, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stderr, ms: Date.now() - started });
      },
    );
  });
};

const dirs: string[] = [];
/** Writes an executable script to a temporary directory, removed after each test. */
const executable = (name: string, body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hashspan-demo-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};
const fakeAnvil = (body: string): string => executable('anvil', `#!/usr/bin/env bash\n${body}\n`);

const servers: Server[] = [];
const listen = async (port = 0): Promise<number> => {
  const server = createServer().listen(port, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return (server.address() as { port: number }).port;
};
/** A port that nothing listens on. */
const freePort = async (): Promise<string> => {
  const port = await listen();
  await new Promise((resolve) => servers.pop()?.close(resolve));
  return String(port);
};
const isOpen = (port: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(Number(port), '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/demo.sh', () => {
  it('fails fast when the port is already in use', async () => {
    const port = String(await listen());
    const result = await run({
      DEMO_PORT: port,
      DEMO_ANVIL: fakeAnvil('exec sleep 10'),
      DEMO_CMD: 'true',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`port ${port} is already in use`);
    expect(result.ms).toBeLessThan(5_000);
  });

  it('stops when Anvil exits before it is ready', async () => {
    const result = await run({
      DEMO_PORT: await freePort(),
      DEMO_ANVIL: fakeAnvil('exit 3'),
      DEMO_CMD: 'true',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Anvil exited before it was ready');
    expect(result.ms).toBeLessThan(5_000);
  });

  it('gives up when Anvil never becomes ready', async () => {
    const result = await run({
      DEMO_PORT: await freePort(),
      DEMO_ANVIL: fakeAnvil('exec sleep 10'),
      DEMO_CMD: 'true',
      DEMO_READY_TIMEOUT: '2',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Anvil was not ready after 2 s');
    expect(result.ms).toBeLessThan(8_000);
  });

  it('fails when Anvil exits and something else answers on the port', async () => {
    const port = await freePort();
    // Hands the port to another process that lives for 3 s, then exits: the port looks ready, Anvil is gone.
    const impostor = fakeAnvil(
      `node -e 'const a = process.argv; require("node:net").createServer().listen(Number(a[a.indexOf("--port") + 1]), "127.0.0.1"); setTimeout(() => process.exit(0), 3000)' -- "$@" >/dev/null 2>&1 &\nsleep 0.5\nexit 0`,
    );
    const result = await run({ DEMO_PORT: port, DEMO_ANVIL: impostor, DEMO_CMD: 'true' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Anvil exited before it was ready');
  });

  it('runs the demo against the new chain, passes its exit status on and stops the chain', async () => {
    const port = await freePort();
    // Listens on the --port it is given, like Anvil.
    const listener = fakeAnvil(
      `exec node -e 'const a = process.argv; require("node:net").createServer().listen(Number(a[a.indexOf("--port") + 1]), "127.0.0.1")' -- "$@"`,
    );
    const demo = executable(
      'demo',
      `#!/usr/bin/env bash\n[ "$RPC_URL" = "http://127.0.0.1:${port}" ] || exit 9\nexit 7\n`,
    );

    const result = await run({ DEMO_PORT: port, DEMO_ANVIL: listener, DEMO_CMD: demo });
    expect(result.code).toBe(7);
    expect(await isOpen(port)).toBe(false);
  });
});
