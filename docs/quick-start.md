# Quick start

A complete, runnable setup: one traced transaction on a local chain, exported to a trace backend. CI runs the
`agent.ts` below as it is written here (`packages/viem/test/quick-start.int.test.ts`). The same walkthrough, on the
website: [hashspan.dev/docs/quickstart](https://hashspan.dev/docs/quickstart).

Requires Node.js 22.3 or later. CI also loads the packed packages on Bun 1.x and Deno 2.x (`require()`,
`import` and a traced send, without a chain); other runtimes are not tested.

```sh
npm install @hashspan/viem @opentelemetry/api viem
npm install @opentelemetry/sdk-node   # unless your app already sets up an OpenTelemetry SDK
npm install -D tsx                    # runs agent.ts below
anvil                                 # in a second terminal: a local chain
```

`anvil` comes with [Foundry](https://getfoundry.sh) and listens on `127.0.0.1:8545`, the URL in `agent.ts` below.
Start a trace backend too: the [local lab](../README.md#local-lab) in a checkout of this repository, or the one-line
[Jaeger container](backends.md#jaeger) (needs Docker); without one, print the spans in the terminal instead
([no backend](backends.md#console-without-a-backend)). Then save this file as `agent.ts`:

```ts
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318. Start it before the first transaction.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http('http://127.0.0.1:8545');

const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

// Stands in for your agent's tool call: the send and confirm spans become its children.
await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    await reader.waitForTransactionReceipt({ hash });
  } finally {
    span.end();
  }
});

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
```

```sh
npm pkg set type=module   # agent.ts uses top-level await
npx tsx agent.ts          # prints nothing on success: the trace is in Jaeger
```

## Notes

- **ES module:** the packages themselves load with both `import` and `require()`; only `agent.ts` needs
  `"type": "module"`.
- **Without tsx:** `node agent.ts` runs the file on Node.js 22.18 or later, which strips the types.
- **Start order:** hashspan gets its tracer and meter from `@opentelemetry/api` when a transaction is sent, so
  `withHashspan()` and the clients may be created before or after `sdk.start()`. Transactions sent before an SDK is
  registered are not recorded; spans and metrics start with the first transaction after it. The tracer taken then is
  kept: a process that replaces the global tracer provider later, as a test may between runs, needs a new
  `withHashspan()` for the new provider, or the provider passed as `tracerProvider`.
- **See it** in Jaeger on `http://localhost:16686`: service `my-agent`, trace `pay_vendor`, with the children
  `send 31337` and `confirm 31337` (the chain id), and the confirm span [linked](backends.md#span-links) to the
  send span. [Backends](backends.md) lists other setups.
- **Base Sepolia:** use `baseSepolia` from `viem/chains`, `http()` or your RPC URL, and a funded key from the
  environment instead: `` privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`) `` from `viem/accounts`.
- **Not an agent:** in a request handler or a job, replace the `pay_vendor` span with the span it already has
  ([services that are not agents](integrations.md#services-that-are-not-agents)).

`flush()` matters in any process that exits after its last transaction
([shutting down](../packages/viem/README.md#shutting-down)). See [`@hashspan/viem`](../packages/viem) for details and
[`@hashspan/core`](../packages/core) to instrument other send paths.
