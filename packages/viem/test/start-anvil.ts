import { Instance } from 'prool';

/** What the test files pass to Anvil; the port is always 0. */
type AnvilParameters = { binary: string; chainId?: number | undefined };

export type StartedAnvil = {
  instance: ReturnType<typeof Instance.anvil>;
  port: number;
  rpcUrl: string;
};

// Starting Anvil can take longer than 10 s while the whole suite runs in parallel (the integration hookTimeout).
const START_TIMEOUT_MS = 60_000;

/** The port in Anvil's "Listening on <host>:<port>" line, once the line is complete; undefined before that. */
export function listeningPort(output: string): number | undefined {
  const match = /Listening on (?:\[[^\]]+\]|[^\s:]+):(\d+)\r?\n/.exec(output);
  return match ? Number(match[1]) : undefined;
}

/**
 * Starts a test file's own Anvil on a port the OS picks as Anvil binds it (`--port 0`), and reads that port from
 * Anvil's "Listening on" line. Asking for a free port first and binding it later left a gap in which another process,
 * such as a test's proxy listening on port 0, could take it (#324). Call it at module level, behind the same condition
 * as the tests if the whole file can be skipped, and stop `instance` in `afterAll`.
 */
export async function startAnvil(parameters: AnvilParameters): Promise<StartedAnvil> {
  const instance = Instance.anvil({ ...parameters, port: 0 }, { timeout: START_TIMEOUT_MS });
  await instance.start();
  try {
    const port = await portOf(instance);
    return { instance, port, rpcUrl: `http://127.0.0.1:${port}` };
  } catch (error) {
    await instance.stop().catch(() => {});
    throw error;
  }
}

/** Reads the port from the messages Anvil printed; waits for the rest of the line if it came in a later chunk. */
function portOf(instance: StartedAnvil['instance']): Promise<number> {
  const output = () => instance.messages.get().join('');
  const port = listeningPort(output());
  if (port !== undefined) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      instance.off('message', onMessage);
      reject(
        new Error(`Anvil started, but printed no "Listening on" line with a port: ${output()}`),
      );
    }, START_TIMEOUT_MS);
    const onMessage = () => {
      const found = listeningPort(output());
      if (found === undefined) return;
      clearTimeout(timer);
      instance.off('message', onMessage);
      resolve(found);
    };
    instance.on('message', onMessage);
  });
}
