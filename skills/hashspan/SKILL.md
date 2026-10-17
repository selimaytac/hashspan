---
name: hashspan
description: Instruments a TypeScript project with hashspan, so that every on-chain transaction or agent payment it sends becomes OpenTelemetry send and confirm spans inside the active trace, exported to Jaeger or any OTLP backend. Use when a project, an AI agent or any other service, sends EVM transactions or x402 payments through viem, the Coinbase CDP SDK or x402 and uses or wants OpenTelemetry tracing of them.
license: Apache-2.0
---

# Instrument a project with hashspan

Follow the steps in order. Each step links to the hashspan documentation that states the rule; read the link when
the project does something the step does not cover.

## 1. Find how the project sends

Search the source for the clients that send, and pick the package for each:

- viem clients (`createWalletClient`, `createPublicClient`, `createBundlerClient`, or a client a library builds from
  them): `@hashspan/viem`.
- A `CdpClient` of `@coinbase/cdp-sdk`: `@hashspan/cdp`
  ([usage](https://github.com/selimaytac/hashspan/blob/main/packages/cdp/README.md#usage)).
- An `x402Client` of `@x402/core`, also behind `@x402/fetch`, `@x402/axios` or `@x402/mcp`: `@hashspan/x402`
  ([usage](https://github.com/selimaytac/hashspan/blob/main/packages/x402/README.md#usage)).
- A toolkit, an agent framework, a smart account SDK or a wallet service in between: find it in the
  [support table](https://github.com/selimaytac/hashspan/blob/main/docs/integrations.md#support-at-a-glance) and
  follow its setup.

Stop and tell the user when the project sends only through another library, such as ethers, or on a chain that is
not EVM: hashspan does not trace those ([not an agent?](https://github.com/selimaytac/hashspan/blob/main/README.md#not-an-agent)).

## 2. Install

With the project's package manager, and on the Node.js version of the
[quick start](https://github.com/selimaytac/hashspan/blob/main/README.md#quick-start):

```sh
npm install @hashspan/viem @opentelemetry/api viem
npm install @opentelemetry/sdk-node
```

- Leave out `@opentelemetry/sdk-node` when the project already starts an OpenTelemetry SDK; keep its setup and use
  its provider in step 3.
- For CDP or x402, add the install line of
  [`@hashspan/cdp`](https://github.com/selimaytac/hashspan/blob/main/packages/cdp/README.md#install) or
  [`@hashspan/x402`](https://github.com/selimaytac/hashspan/blob/main/packages/x402/README.md#install).
- Install the same minor version of every `@hashspan` package
  ([packages](https://github.com/selimaytac/hashspan/blob/main/README.md#packages)).

## 3. Start the SDK first

Add this file as `instrumentation.ts` next to the entry point, and set `serviceName` to the project's name:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318, or to OTEL_EXPORTER_OTLP_ENDPOINT.
const sdk = new NodeSDK({ serviceName: 'my-service' });
sdk.start();

// One result for every client of the process, so that confirm spans link to their send spans.
export const hashspan = withHashspan();

// hashspan's pending spans first, then the SDK's.
export async function shutdown(): Promise<void> {
  await hashspan.flush();
  await sdk.shutdown();
}

// A service that is stopped flushes too.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit());
  });
}
```

- Import it before anything else in the entry point (`import { shutdown } from './instrumentation.js';` as the first
  import): transactions sent before an SDK is registered are not recorded
  ([start order](https://github.com/selimaytac/hashspan/blob/main/README.md#quick-start)).
- When the code never waits for receipts through a client it extends (no `waitForTransactionReceipt`), replace
  `withHashspan()` with `withHashspan({ confirm: { mode: 'background', timeoutMs: 60_000 } })`, or there are no
  confirm spans ([background confirmation](https://github.com/selimaytac/hashspan/blob/main/packages/viem/README.md#background-confirmation)).
- An AI agent can be named with the `agent` option; other services leave it out
  ([options](https://github.com/selimaytac/hashspan/blob/main/packages/core/README.md#options)).
- With an existing SDK setup, keep only the `hashspan` and `shutdown` parts, with that setup's provider in place of
  `sdk`.

## 4. Extend every client

- Add `.extend(hashspan)` to every viem wallet and public client that sends or waits for receipts, importing
  `hashspan` from `./instrumentation.js`
  ([usage](https://github.com/selimaytac/hashspan/blob/main/packages/viem/README.md#usage)).
- Apply it after other extensions, such as `publicActions`
  ([apply it last](https://github.com/selimaytac/hashspan/blob/main/packages/viem/README.md#apply-it-last)).
- Smart account SDKs are the exception: build the client with `withHashspan()` before the SDK's actions, as in
  [smart account SDKs](https://github.com/selimaytac/hashspan/blob/main/docs/integrations.md#smart-account-sdks).
- Extend a client before handing it to a library that takes one
  ([libraries that take a viem client](https://github.com/selimaytac/hashspan/blob/main/docs/integrations.md#libraries-that-take-a-viem-client)).
- CDP and x402 wrap their client once, right after it is created, and get a viem public client as `reader` for
  confirm spans; flush their handle in `shutdown()` as well
  ([CDP](https://github.com/selimaytac/hashspan/blob/main/packages/cdp/README.md#with-hashspanviem),
  [x402](https://github.com/selimaytac/hashspan/blob/main/packages/x402/README.md#usage)).
- Agent frameworks: the spans nest under the span active when the transaction is sent, so the framework's own
  OpenTelemetry integration must be on for them to appear under its tool spans
  ([agent frameworks](https://github.com/selimaytac/hashspan/blob/main/docs/integrations.md#agent-frameworks)).

## 5. Flush before exit

- A script, CLI or job that exits by itself ends its entry point with `await shutdown();`, after its last
  transaction. Without it, spans that end after the traced call are lost
  ([shutting down](https://github.com/selimaytac/hashspan/blob/main/packages/viem/README.md#shutting-down)).
- A long-running service needs nothing more: the signal handlers of step 3 flush when it is stopped.
- When the project already handles shutdown, call `shutdown()` from that handler instead of the loop in step 3.

## 6. See the traces

1. Start a backend: Jaeger in one command
   ([Jaeger](https://github.com/selimaytac/hashspan/blob/main/docs/backends.md#jaeger)), the
   [local lab](https://github.com/selimaytac/hashspan/blob/main/README.md#local-lab) in a checkout of hashspan, or
   none, with the spans printed in the terminal
   ([console](https://github.com/selimaytac/hashspan/blob/main/docs/backends.md#console-without-a-backend)).
2. Run the project against a local chain or a testnet, never with a key that holds real funds unless the user asks.
3. Check that each transaction shows `send {chainId}` and `confirm {chainId}` spans under the span that was active
   when it was sent. When one is missing, follow
   [troubleshooting](https://github.com/selimaytac/hashspan/blob/main/docs/troubleshooting.md).
4. Run the project's typecheck and tests.
