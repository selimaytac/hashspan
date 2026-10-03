// Shared by the OpenInference tests: an Anvil node, a traced wallet client of a funded agent, the tool function of
// docs/integrations.md ("Agent frameworks") and the span lookups the tests assert on.
import { withHashspan } from '@hashspan/viem';
import { type Span, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import {
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  parseEther,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry as chain } from 'viem/chains';
import { setupTracing, type TestTracing } from '../../packages/viem/test/tracing.js';

export { chain };

type ReadableSpan = ReturnType<TestTracing['spans']>[number];

export const AGENT_SPAN = 'treasury-agent';
export const TOOL_SPAN = 'pay_vendor';
export const OPENINFERENCE_KIND = 'openinference.span.kind';
const VENDOR = '0x00000000000000000000000000000000000000cc';

/** Starts Anvil on `port` and registers the in-memory tracer provider; call the result's `stop` in `afterAll`. */
export async function startAnvil(port: number): Promise<{
  rpcUrl: string;
  tracing: TestTracing;
  stop: () => Promise<void>;
}> {
  const instance = Instance.anvil({
    binary: new URL('../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: chain.id,
  });
  await instance.start();
  const tracing = setupTracing();
  return {
    rpcUrl: `http://127.0.0.1:${port}`,
    tracing,
    stop: async () => {
      await tracing.teardown();
      await instance.stop();
    },
  };
}

/**
 * A wallet client of a throwaway, funded agent account, with public actions (the tool waits for its receipt) and
 * `withHashspan()`, applied last.
 */
export async function tracedWallet(rpcUrl: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  await createPublicClient({ chain, transport: http(rpcUrl) }).request({
    method: 'anvil_setBalance' as never,
    params: [account.address, `0x${parseEther('10').toString(16)}`] as never,
  });
  const hashspan = withHashspan();
  return Object.assign(
    createWalletClient({ account, chain, transport: http(rpcUrl) })
      .extend(publicActions)
      .extend(hashspan),
    { flush: hashspan.flush },
  );
}

type Wallet = Awaited<ReturnType<typeof tracedWallet>>;

/** Sends a transaction and waits for its receipt, as an agent's tool would. */
async function pay(wallet: Wallet): Promise<Hex> {
  const hash = await wallet.sendTransaction({ to: VENDOR, value: 1n });
  await wallet.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * The tool's function. With `workaround`, it runs in an active span of its own, as docs/integrations.md recommends;
 * without, hashspan's spans attach to whatever span is active when the framework runs the tool.
 */
export function payVendor(wallet: Wallet, workaround: boolean): () => Promise<Hex> {
  if (!workaround) return () => pay(wallet);
  const tracer = trace.getTracer('treasury-agent');
  return () =>
    tracer.startActiveSpan(TOOL_SPAN, async (span) => {
      try {
        return await pay(wallet);
      } finally {
        span.end();
      }
    });
}

/** Runs `agent` inside an active span named AGENT_SPAN, as an application that traces its agent runs would. */
export function inAgentSpan<T>(agent: () => Promise<T>): Promise<T> {
  return trace.getTracer('treasury-agent').startActiveSpan(AGENT_SPAN, async (span: Span) => {
    try {
      return await agent();
    } finally {
      span.end();
    }
  });
}

/** The spans of one run, by role. */
export function spansOf(tracing: TestTracing): {
  all: ReadableSpan[];
  send: ReadableSpan;
  confirm: ReadableSpan;
  agent: ReadableSpan;
  workaround: ReadableSpan | undefined;
  openInference: ReadableSpan[];
  parentName: (span: ReadableSpan) => string | undefined;
} {
  const all = tracing.spans();
  const parentName = (span: ReadableSpan) =>
    all.find((s) => s.spanContext().spanId === span.parentSpanContext?.spanId)?.name;
  return {
    all,
    send: tracing.spanNamed(`send ${chain.id}`),
    confirm: tracing.spanNamed(`confirm ${chain.id}`),
    agent: tracing.spanNamed(AGENT_SPAN),
    // OpenInference's TOOL span has the tool's name too, but carries an OpenInference span kind.
    workaround: all.find(
      (span) => span.name === TOOL_SPAN && span.attributes[OPENINFERENCE_KIND] === undefined,
    ),
    openInference: all.filter((span) => span.attributes[OPENINFERENCE_KIND] !== undefined),
    parentName,
  };
}
