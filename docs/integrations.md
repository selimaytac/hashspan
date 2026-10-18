# Integrations

Agents and services rarely call viem or the CDP SDK directly: a toolkit, a framework or a wallet service sits in
between. hashspan traces the client those libraries send through, so most integrations come down to handing them a
traced client.
This page collects the setups that were checked; each code block is compiled in CI. When a span is missing, see
[troubleshooting](troubleshooting.md).

## Support at a glance

| Setup | Use | Extra setup | Known limits | Runs in CI |
|---|---|---|---|---|
| viem wallet and public clients | `@hashspan/viem` [`withHashspan()`](../packages/viem/README.md#usage) | apply it last; one result per agent | a library that calls viem's actions as functions is not traced ([below](#libraries-that-take-a-viem-client)) | `packages/viem` tests |
| viem bundler client (ERC-4337) | `@hashspan/viem` | a tracker from `@hashspan/core` 0.8 or later | no background confirmation or `watch()` for user operations ([smart accounts](../packages/viem/README.md#smart-accounts-erc-4337)) | `packages/viem` tests, a real bundler in CI only |
| permissionless.js smart account client | `@hashspan/viem` | build the client with `withHashspan()` before `smartAccountActions` | applied last, only `sendUserOperation` and `waitForUserOperationReceipt` are traced ([setup](#smart-account-sdks)) | `integrations/`, with a stand-in account |
| ZeroDev Kernel account client | `@hashspan/viem` | none | only `sendUserOperation` and `waitForUserOperationReceipt` are traced; `sendTransaction` and `writeContract` are not ([setup](#smart-account-sdks)) | `integrations/`, with a stand-in account |
| EIP-5792 wallet (`sendCalls`) | `@hashspan/viem` | none | no fees on the batch; `getCallsStatus` is not traced ([call batches](../packages/viem/README.md#call-batches-eip-5792)) | `packages/viem` tests |
| Transactions sent elsewhere | `@hashspan/viem` [`watch()`](../packages/viem/README.md#transactions-sent-elsewhere) | a public client; for a send span, the call recorded with the same tracker | a send span only when you record the call | `packages/viem` tests |
| Coinbase CDP SDK | `@hashspan/cdp` | a `reader` for confirm spans | CommonJS needs Node.js 22.12 ([install](../packages/cdp/README.md#install)); see [known limits](../packages/cdp/README.md#known-limits) | `packages/cdp` tests |
| x402 client | `@hashspan/x402` | a `reader` for `verified` | x402 v1 and non-`eip155` networks are not traced ([known limits](../packages/x402/README.md#known-limits)) | `packages/x402` tests |
| MPP client (mppx) | `@hashspan/mpp` | a `reader` for confirm spans and `verified`; for push, the payer's viem client extended on the same `tracker` ([setup](#machine-payments-protocol-mppx)) | Tempo `charge` only: sessions and paid MCP tools are not traced ([known limits](../packages/mpp/README.md#known-limits)) | `packages/mpp` tests, on Anvil in Tempo mode |
| AgentKit `ViemWalletProvider` | `@hashspan/viem` | background confirmation | TypeScript needs a cast ([setup](#viemwalletprovider)) | `integrations/` |
| AgentKit `CdpEvmWalletProvider`, `CdpSmartWalletProvider` | `@hashspan/cdp` on `getClient()` | the provider's public client as `reader` | `configureWithWallet()` itself is not run in CI ([setup](#cdpevmwalletprovider)) | `integrations/` |
| Other AgentKit wallet providers | `@hashspan/viem` `watch()` | the returned hash | a send span only when you record the call ([setup](#other-wallet-providers)) | the pattern in `packages/viem` tests |
| GOAT | `@hashspan/viem` | background confirmation | no longer maintained ([setup](#goat-sdk)) | `integrations/` |
| Mastra | `@hashspan/viem` | Mastra's OpenTelemetry bridge | the bridge is experimental ([setup](#agent-frameworks)) | `integrations/` |
| Genkit | `@hashspan/viem` | `disableGenkitOTelInitialization()`, and your SDK started before Genkit's first span | `generate` starts a trace of its own inside an active span unless `disableOTelRootSpanDetection()` is called; Genkit's Developer UI gets no spans ([setup](#agent-frameworks)) | `integrations/` |
| LangChain JS, OpenAI Agents SDK (OpenInference) | `@hashspan/viem` | run tools in an active span of your own | tool spans are not active ([setup](#agent-frameworks)) | `integrations/` |
| MCP server tools (stdio) | `@hashspan/viem` in the server | the agent's trace context in each request's `_meta`: OpenInference's MCP instrumentation (v1 SDK) or a few lines of your own (v2 SDK) | without it, the server's spans start a trace of their own; pass the `OTEL_*` settings to the server ([setup](#mcp-servers)) | `integrations/` |
| ElizaOS `plugin-evm` | none | none | not traced: it creates its own wallet client ([details](#agent-frameworks)) | no |
| Coinbase Agentic Wallets (`awal`, payments MCP) | none | none | not traced: sends run as smart account user operations in a Coinbase-hosted page inside awal's own app; `watch()` on the returned hash records the bundle transaction, not the account's operation | no |
| Wallet services with a viem account (Turnkey, Privy) | `@hashspan/viem` | none | none ([setup](#wallet-services)) | as viem clients |
| Wallet services with an EIP-1193 provider (Circle, Fireblocks) | `@hashspan/viem` on a `custom()` transport | a public client for receipts when the provider does not answer reads | Circle smart contract accounts not checked ([setup](#wallet-services)) | the pattern in `packages/viem` tests |
| Wallet services that send through their API | `@hashspan/viem` `watch()` | a public client; for a send span, the API call recorded with the same tracker | none ([setup](#wallet-services)) | the pattern in `packages/viem` tests |
| Hardhat 3 scripts and tests (hardhat-viem) | `@hashspan/viem` on the clients of `viem.getPublicClient()` and `viem.getWalletClients()` | pass them as `client` to `deployContract` and `getContractAt` | a deployment gets a confirm span only; Ignition deployments are not traced ([setup](#hardhat-3)) | `integrations/`, on Hardhat's in-process network |
| eRPC gateway in front of the nodes | `@hashspan/viem` with `traceTransport()` | `@opentelemetry/instrumentation-undici`, so requests carry `traceparent` | two client spans per request; tracing over http needs a `host:port` endpoint ([setup](#rpc-gateways-erpc)) | `integrations/`, eRPC 0.4.0 in front of Anvil |

## Libraries that take a viem client

When a library accepts a viem wallet client, extend the client before you hand it over:

- `client.extend(withHashspan())` traces `sendTransaction`, `writeContract` and `sendRawTransaction` as long as the
  library calls them as methods of that client. A library that calls viem's actions with the client as an argument
  (`sendTransaction(client, ...)` from `viem/actions`) bypasses the extension for that action; the call is recorded
  only through the client's own actions viem calls inside it. `writeContract` sends through the client's
  `sendTransaction` (a send span without the function name); with a local account, `sendTransaction` and
  `sendTransactionSync` sign and send through the client's `sendRawTransaction` and `sendRawTransactionSync` (without
  the sender). `sendTransaction` with an address-only account is not traced.
- If the library waits for receipts on a client of its own, the confirm span is not recorded by that wait. Use
  [background confirmation](../packages/viem/README.md#background-confirmation) so hashspan polls for the receipt
  itself.
- Apply `withHashspan()` last ([why](../packages/viem/README.md#apply-it-last)).

## Smart account SDKs

Checked with permissionless 0.5.0 and `@zerodev/sdk` 5.5.11. Their smart account clients
(`createSmartAccountClient`, `createKernelAccountClient`) are viem bundler clients with actions of the SDK on top:
`sendTransaction` and `writeContract` (and permissionless's `sendCalls`) send a user operation, wait for its receipt
and return the bundle transaction's hash. Those actions reach the bundler through the client they were added to, so
`withHashspan()` applied to the finished client does not see the operation
([smart account SDKs](../packages/viem/README.md#smart-account-sdks)).

For user operation spans from `sendTransaction`, `writeContract` and `sendCalls`, build the client that
`createSmartAccountClient` builds with viem's `createBundlerClient`, and apply `withHashspan()` before
permissionless's `smartAccountActions`. On Anvil, with the OpenTelemetry SDK started as in the
[quick start](../README.md#quick-start), where `account` is your permissionless smart account (for example from
`toSimpleSmartAccount`) and `bundlerUrl` your bundler's:

```ts
import { withHashspan } from '@hashspan/viem';
import { smartAccountActions } from 'permissionless';
import { createPublicClient, http, parseEther } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { foundry } from 'viem/chains';

// Start the OpenTelemetry SDK before this, as in the quick start.
const hashspan = withHashspan();
const client = createPublicClient({ chain: foundry, transport: http('http://127.0.0.1:8545') }); // Anvil

// The client createSmartAccountClient({ account, client, bundlerTransport }) builds, with hashspan applied before
// permissionless's actions, so that they send through the traced user operation actions.
const smartAccountClient = createBundlerClient({ account, client, transport: http(bundlerUrl) })
  .extend(hashspan)
  .extend(smartAccountActions);

// A user operation send span, and its confirm span as permissionless waits for the operation's receipt.
const hash = await smartAccountClient.sendTransaction({
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  value: parseEther('0.001'),
});
// `hash` is the bundle transaction's: a wait for it on a traced client would record the bundle, not the operation.
console.log(hash);

// Before a short-lived process exits, then shut the SDK down:
await hashspan.flush();
```

- `createBundlerClient` takes the same `paymaster`, `paymasterContext` and `userOperation` options as
  `createSmartAccountClient`. With a custom `userOperation.prepareUserOperation`, `createSmartAccountClient` adds
  an action of its own that calls it, which this setup does not.
- `createSmartAccountClient(...).extend(withHashspan())` still traces `sendUserOperation` and
  `waitForUserOperationReceipt` when you call them; its `sendTransaction`, `writeContract` and `sendCalls` are then
  not traced, with a `diag` warning. TypeScript accepts that extension only with a cast, since viem's `extend()`
  types expect viem's own `sendTransaction`.
- ZeroDev's `createKernelAccountClient` builds its client the same way, and adds `sendTransaction` and
  `writeContract` with `kernelAccountClientActions()`. Extended with `withHashspan()` (with the same cast), its
  `sendUserOperation` and `waitForUserOperationReceipt` are traced and its `sendTransaction` and `writeContract` are
  not. A client built by hand with `withHashspan()` before ZeroDev's actions is not tested: `createKernelAccountClient`
  also sets ZeroDev's fee estimate and an EIP-7702 authorization step.
- In CI, both SDKs run with a stand-in smart account on a stand-in EntryPoint, since Kernel's and SimpleAccount's
  contracts are not available to the tests; the user operation spans themselves are also checked through a real
  bundler ([smart accounts](../packages/viem/README.md#smart-accounts-erc-4337)).

## Coinbase AgentKit

Checked with `@coinbase/agentkit` 0.10.4. AgentKit sends through a wallet provider; three of them can be traced
without extra code.

### `ViemWalletProvider`

The provider sends with the wallet client you give it, and waits for receipts with a public client it creates
itself, so the setup needs background confirmation. On Anvil, with the OpenTelemetry SDK started as in the
[quick start](../README.md#quick-start), in an ES module as there (`npm pkg set type=module`), since the file uses
top-level await:

```ts
import { ViemWalletProvider } from '@coinbase/agentkit';
import { withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Start the OpenTelemetry SDK before this, as in the quick start.
const rpcUrl = 'http://127.0.0.1:8545'; // Anvil
const account = mnemonicToAccount('test test test test test test test test test test test junk');

// The provider waits for receipts on a client of its own: background confirmation records them.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const walletClient = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) }).extend(
  hashspan,
);
const walletProvider = new ViemWalletProvider(
  // AgentKit pins its own viem: see below.
  walletClient as unknown as ConstructorParameters<typeof ViemWalletProvider>[0],
  { rpcUrl },
);

await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    // The amount in wei, as a decimal string.
    await walletProvider.nativeTransfer(
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      parseEther('0.01').toString(),
    );
  } finally {
    span.end();
  }
});

// Before a short-lived process exits, then shut the SDK down:
await hashspan.flush();
```

`sendTransaction`, `nativeTransfer` and the action providers that send through the wallet provider (such as the
ERC-20 actions) then record a `send` and a `confirm` span per transaction; without background confirmation, only
the send spans are recorded. CI runs this setup against Anvil with `sendTransaction`, `nativeTransfer` and the ERC-20
`approve` action, both ways, in
[`integrations/test/agentkit-viem.int.test.ts`](../integrations/test/agentkit-viem.int.test.ts).

Two details of the provider apply with or without hashspan:

- Its public client connects to the `rpcUrl` of its second argument, else to the `RPC_URL` environment variable,
  else to the chain's default RPC; never through the wallet client's transport.
- AgentKit 0.10.4 depends on viem 2.38.3 exactly. With another viem in the application (2.57 in the test),
  TypeScript rejects the wallet client in `new ViemWalletProvider(walletClient)`, while the client works at runtime.
  Cast it as the test does, with or without hashspan:
  `new ViemWalletProvider(walletClient as unknown as ConstructorParameters<typeof ViemWalletProvider>[0])`. With the
  same viem version as AgentKit, no cast is needed. tsx does not check types, so without the cast the error shows
  only under `tsc`.
- `nativeTransfer(to, value)` takes the amount in wei as a decimal string: `'0.01'` throws, while
  `parseEther('0.01').toString()` sends 0.01 ETH.

### `CdpEvmWalletProvider`

The provider sends through its `CdpClient`, which `getClient()` returns. Wrap it with `@hashspan/cdp`, with the
provider's public client as the reader:

```ts
import { withHashspan } from '@hashspan/cdp';

const walletProvider = await CdpEvmWalletProvider.configureWithWallet(config);
// Wraps the provider's CdpClient in place, before its first transaction.
const hashspan = withHashspan(walletProvider.getClient(), {
  reader: walletProvider.getPublicClient(),
});
```

The provider calls `cdp.evm.sendTransaction`, which the wrapper traces; `sendTransaction`, `nativeTransfer` and the
action providers that send through the wallet provider then record a `send` and a `confirm` span per transaction.

The same setup covers `CdpSmartWalletProvider`, which also has `getClient()` and `getPublicClient()`: it sends ERC-4337
user operations with `cdp.evm.sendUserOperation` and waits with `cdp.evm.waitForUserOperation`, which the wrapper
records as user operation spans ([smart accounts](../packages/cdp/README.md#smart-accounts)).

CI runs both providers against a local stand-in for the CDP API and Anvil, in
[`integrations/test/agentkit-cdp.int.test.ts`](../integrations/test/agentkit-cdp.int.test.ts): `sendTransaction`,
`nativeTransfer` and the ERC-20 `approve` action of `CdpEvmWalletProvider`, and `sendTransaction` and
`waitForTransactionReceipt` of `CdpSmartWalletProvider`. `configureWithWallet()` itself is not run: it creates its
`CdpClient` from the API key and wallet secret only, its config in AgentKit 0.10.4 has no field for the client's
`basePath` option, and the CDP SDK reads no environment variable for the API's base URL. The test builds each
provider with the constructor that `configureWithWallet()` ends with, around a `CdpClient` created with `basePath`.

### Other wallet providers

- `PrivyEvmWalletProvider`, `PrivyEvmDelegatedEmbeddedWalletProvider`, `ZeroDevWalletProvider` and the legacy CDP
  providers build their clients internally or send through their own APIs. Record their transactions with
  [`watch()`](../packages/viem/README.md#transactions-sent-elsewhere) and the hash the provider returns, and wrap the
  provider's send call as shown there for a send span.

AgentKit reports each wallet provider's initialization and each action invocation to its analytics endpoint; this
is AgentKit's own behaviour and independent of hashspan. In 0.10.4 the report is not awaited, so any failure, a
request that cannot connect or a response that is not 2xx, is an unhandled rejection, and Node.js ends the process
when it happens: possibly after the transaction is sent but before `hashspan.flush()` and the SDK's shutdown run, so
its spans are never exported. AgentKit has no setting to turn the reports off
([coinbase/agentkit#1531](https://github.com/coinbase/agentkit/issues/1531)); running Node.js with
`NODE_OPTIONS=--unhandled-rejections=warn` logs the rejection instead and lets the process finish.

## GOAT SDK

GOAT is no longer maintained: since July 2026 its repository is a read-only snapshot that accepts no issues or pull
requests, and `@goat-sdk/core` 0.5.0 and `@goat-sdk/wallet-viem` 0.3.0 (May 2025) are its last releases. The setup
below works with those releases.

Checked with `@goat-sdk/wallet-viem` 0.3.0. GOAT sends with methods of the wallet client you pass to `viem()`, and
waits for receipts on a client it derives from it, so the setup needs background confirmation:

```ts
// GOAT waits for receipts on a client it derives from this one: background confirmation records them.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const wallet = viem(createWalletClient({ account, chain, transport: http() }).extend(hashspan));
```

Pass `wallet` to GOAT as usual, for example `getOnChainTools({ wallet })`. A transaction sent through it then records a
`send` and a `confirm` span. CI runs this setup against Anvil with GOAT's `send_token` and `approve_token_evm` tools,
invoked directly, both ways, in [`integrations/test/goat-viem.int.test.ts`](../integrations/test/goat-viem.int.test.ts).

`@goat-sdk/wallet-viem` 0.3.0 pins viem 2.23.4 exactly. With a newer viem in the application (2.57 in the test),
TypeScript rejects the wallet client in `viem(walletClient)`, while the client works at runtime. Cast it as the test
does, with or without hashspan: `viem(walletClient as unknown as Parameters<typeof viem>[0])`. With viem 2.23.4 itself,
no cast is needed.

GOAT's packages have no `exports` map, so Node.js loads their CommonJS build even from an ES module; the application's
viem and GOAT's then come from different module copies. With viem 2.57 this does not affect the spans, because hashspan wraps the client
instance rather than a module.

## Agent frameworks

hashspan's spans are children of the OpenTelemetry span that is active when the transaction is sent. Whether a
framework's tool-call span is that span depends on its instrumentation. A framework's own spans follow its own
privacy settings, not hashspan's: see the
[privacy notes](../packages/core/README.md#privacy-notes).

- **Mastra:** with its OpenTelemetry bridge (`OtelBridge` from `@mastra/otel-bridge`, set as `bridge` in an
  `Observability` config of `@mastra/observability`) and a registered tracer provider and context manager (the
  OpenTelemetry Node SDK registers both), each tool runs inside its tool span: the trace reads
  `invoke_agent <agent>`, then Mastra's spans of the model call and the agent's step, then `execute_tool <tool>`,
  whose children are `send` and `confirm`. Without Mastra observability, the send and confirm spans start traces of
  their own. CI runs both setups against Anvil with a scripted model, from `@mastra/core` 1.74.0 and
  `@mastra/otel-bridge` 1.5.13 on, in [`integrations/test/mastra.int.test.ts`](../integrations/test/mastra.int.test.ts).
  Mastra marks the bridge as experimental. To set it up:
  - Install `@mastra/core @mastra/observability @mastra/otel-bridge zod @opentelemetry/sdk-node` next to the
    packages of the [quick start](../README.md#quick-start), and `ai` 7 for the scripted model below: it stands in
    for a model provider so the example needs no API key, and an agent with a real model does not need `ai`.
  - Start the Node SDK before the agent runs a tool, give Mastra the bridge, and send from the tool with a client
    extended with `withHashspan()`, as in this `agent.ts`. It runs against Anvil like the quick start, prints the
    agent's answer, and the trace shows in Jaeger under the service `my-agent`: `execute_tool pay_vendor`, with
    `send 31337` and `confirm 31337` under it. CI runs the file as written against Anvil in
    [`integrations/test/mastra-agent.int.test.ts`](../integrations/test/mastra-agent.int.test.ts).
  - Flush before the process exits, as the example does: `await hashspan.flush()`, then `await sdk.shutdown()`
    ([shutting down](../packages/viem/README.md#shutting-down)).
  - Mastra's warning that no `storage` is configured and it falls back to an in-memory store is expected: tracing
    needs no storage.

```ts
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';
import { OtelBridge } from '@mastra/otel-bridge';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { MockLanguageModelV4 } from 'ai/test';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { z } from 'zod';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318. Start it before the agent runs a tool.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http('http://127.0.0.1:8545');
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

const payVendor = createTool({
  id: 'pay_vendor',
  description: 'Pays the vendor an amount of ETH.',
  inputSchema: z.object({ amountEth: z.string() }),
  execute: async ({ amountEth }) => {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  },
});

// A scripted model instead of a provider, so no API key is needed: it calls the tool once, then answers.
const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const model = new MockLanguageModelV4({
  doGenerate: [
    {
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'pay_vendor', input: '{"amountEth":"0.01"}' }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'Paid the vendor 0.01 ETH.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  ],
});

const agent = new Agent({
  id: 'treasury',
  name: 'treasury',
  instructions: 'Pay vendors when asked.',
  model,
  tools: { pay_vendor: payVendor },
});
// The bridge runs each tool inside its execute_tool span, so the send and confirm spans become its children.
new Mastra({
  agents: { treasury: agent },
  observability: new Observability({
    configs: { default: { serviceName: 'my-agent', bridge: new OtelBridge() } },
  }),
});

const result = await agent.generate('Pay the vendor 0.01 ETH.');
console.log(result.text);

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
```

- **Genkit:** Genkit runs each tool's function inside the tool's span, so with a registered tracer provider and
  context manager the trace reads `generate`, then Genkit's spans of the model calls and of the tool, `pay_vendor`,
  whose children are `send` and `confirm`. On its first span Genkit starts an OpenTelemetry Node SDK of its own,
  from the 1.x SDK line (`@opentelemetry/sdk-node` 0.52), unless `disableGenkitOTelInitialization()` from
  `genkit/tracing` was called first. Both SDK lines install side by side; OpenTelemetry keeps the first tracer
  provider registered in a process and refuses the others. CI runs the example below as written and the setups of
  the limits against Anvil with a scripted model, from `genkit` 1.42.0 on, in
  [`integrations/test/genkit.int.test.ts`](../integrations/test/genkit.int.test.ts). To set it up:
  - Install `genkit @opentelemetry/sdk-node` next to the packages of the [quick start](../README.md#quick-start).
    The scripted model below stands in for a model plugin, so the example needs no API key.
  - Call `disableGenkitOTelInitialization()` and start the Node SDK before Genkit runs anything, and send from the
    tool with a client extended with `withHashspan()`, as in this `agent.ts`. It runs against Anvil like the quick
    start, prints the model's answer, and the trace shows in Jaeger under the service `my-agent`: `pay_vendor`,
    with `send 31337` and `confirm 31337` under it.
  - Flush before the process exits, as the example does: `await hashspan.flush()`, then `await sdk.shutdown()`
    ([shutting down](../packages/viem/README.md#shutting-down)).

```ts
import { withHashspan } from '@hashspan/viem';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { genkit, z } from 'genkit';
import { disableGenkitOTelInitialization } from 'genkit/tracing';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Genkit starts an OpenTelemetry SDK of its own on its first span unless told not to: this process has one.
disableGenkitOTelInitialization();
// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise. Start it before
// Genkit runs anything.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http(process.env.RPC_URL ?? 'http://127.0.0.1:8545'); // Anvil
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

const ai = genkit({});

// Genkit runs the tool's function inside the tool's span, so the send and confirm spans become its children.
const payVendor = ai.defineTool(
  {
    name: 'pay_vendor',
    description: 'Pays the vendor an amount of ETH.',
    inputSchema: z.object({ amountEth: z.string() }),
    outputSchema: z.object({ hash: z.string(), status: z.string() }),
  },
  async ({ amountEth }) => {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  },
);

// A scripted model instead of a provider plugin, so no API key is needed: it asks for the tool once, then answers.
ai.defineModel({ name: 'scripted' }, async (request) => {
  const paid = request.messages.some((message) => message.content.some((part) => part.toolResponse));
  return {
    message: {
      role: 'model',
      content: paid
        ? [{ text: 'Paid the vendor 0.01 ETH.' }]
        : [{ toolRequest: { name: 'pay_vendor', ref: 'call_1', input: { amountEth: '0.01' } } }],
    },
    finishReason: 'stop',
  };
});

const { text } = await ai.generate({
  model: 'scripted',
  prompt: 'Pay the vendor 0.01 ETH.',
  tools: [payVendor],
});
console.log(text);

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
```

Known limits with Genkit 1.42; CI checks the first two, with and without the calls they name:

- **Start your SDK first:** without `disableGenkitOTelInitialization()`, when a Genkit span starts before your SDK
  does, Genkit's own SDK registers the tracer provider, your SDK's registration fails, and none of the process's
  spans reach your exporters. With your SDK started first, the trace is recorded as above, and Genkit's SDK fails to
  register and stays idle; with a diag logger set, OpenTelemetry reports
  `Attempted duplicate registration of API: trace` for it.
- **An active span of your own:** `generate` starts a trace of its own even when a span is active, such as an HTTP
  server's span. Call `disableOTelRootSpanDetection()` from `genkit/tracing` at startup to make it a child of the
  active span.
- **Genkit's Developer UI:** Genkit sends traces to its Developer UI (`GENKIT_TELEMETRY_SERVER`) only through a span
  processor of its own SDK, so with this setup the Developer UI receives no spans.

- **LangChain JS and the OpenAI Agents SDK:** OpenInference's instrumentations
  (`@arizeai/openinference-instrumentation-langchain` 4.1.4, `@arizeai/openinference-instrumentation-openai-agents`
  0.3.2) record tool spans but do not make them active, so hashspan's spans attach to whatever span was active
  before the agent ran (upstream:
  [Arize-ai/openinference#3925](https://github.com/Arize-ai/openinference/issues/3925) for the OpenAI Agents SDK,
  [#1103](https://github.com/Arize-ai/openinference/issues/1103) for LangChain JS). When the agent runs inside an
  active span of your own, hashspan's spans and OpenInference's spans are in that span's trace. CI runs both
  instrumentations against Anvil with a scripted model (`langchain` 1.5.15 and `@openai/agents` 0.18.0), with and
  without the workaround below, in
  [`integrations/test/openinference-langchain.int.test.ts`](../integrations/test/openinference-langchain.int.test.ts)
  and
  [`integrations/test/openinference-openai-agents.int.test.ts`](../integrations/test/openinference-openai-agents.int.test.ts).
  The OpenAI Agents SDK turns its tracing off when `NODE_ENV` is `test`, so OpenInference records nothing there
  until `setTracingDisabled(false)` is called. To group a tool's transactions, run the tool's function in an active
  span of your own; that span is a sibling of OpenInference's tool span, not its child:

```ts
const tracer = trace.getTracer('treasury-agent');

// The tool's function: its send and confirm spans become children of `pay_vendor`.
async function payVendor(): Promise<`0x${string}`> {
  return tracer.startActiveSpan('pay_vendor', async (span) => {
    try {
      const hash = await wallet.sendTransaction({ to, value });
      await wallet.waitForTransactionReceipt({ hash });
      return hash;
    } finally {
      span.end();
    }
  });
}
```

- **ElizaOS:** `@elizaos/plugin-evm` 1.0.13 creates a new wallet client from the `EVM_PRIVATE_KEY` setting for each
  action and offers no way to pass a client of your own, so its transactions are not traced today.

## MCP servers

When an agent calls a tool of an MCP server and that tool sends the transaction, hashspan runs in the server's
process, and its spans are children of the span active there. Nothing in the MCP SDKs carries the agent's trace
context to the server, so the server's `send` and `confirm` spans start a trace of their own, apart from the agent's
tool call. MCP reserves the `traceparent`, `tracestate` and `baggage` keys of a request's `_meta` for W3C trace
context; the v2 SDK exports their names (`TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`, `BAGGAGE_META_KEY`), but
neither SDK fills or reads them. Checked over stdio with `@modelcontextprotocol/sdk` 1.32.1 (v1) and
`@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.3.1 (v2).

With the v2 SDK, inject the active context into the `_meta` of each tool call, and run each tool handler in the
context it extracts from `ctx.mcpReq._meta`. The server, `mcp-server.ts`, sends with a client extended with
`withHashspan()`:

```ts
import { withHashspan } from '@hashspan/viem';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { context, propagation } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { z } from 'zod';

// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise. Never log to
// stdout: it carries the MCP messages.
const sdk = new NodeSDK({ serviceName: 'wallet-mcp' });
sdk.start();

const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http(process.env.RPC_URL ?? 'http://127.0.0.1:8545'); // Anvil
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

/** Runs `fn` in the trace context the client sent in the request's `_meta`. */
function inClientTrace<T>(ctx: ServerContext, fn: () => Promise<T>): Promise<T> {
  return context.with(propagation.extract(context.active(), ctx.mcpReq._meta ?? {}), fn);
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'wallet', version: '1.0.0' });
  server.registerTool(
    'pay_vendor',
    { description: 'Pays the vendor an amount of ETH.', inputSchema: z.object({ amountEth: z.string() }) },
    ({ amountEth }, ctx) =>
      inClientTrace(ctx, async () => {
        const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
        const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
        const receipt = await reader.waitForTransactionReceipt({ hash });
        return { content: [{ type: 'text', text: `${hash} ${receipt.status}` }] };
      }),
  );
  return server;
}

serveStdio(createServer);

// The client ends stdin to stop the server: export the pending spans before the process exits.
process.stdin.once('end', async () => {
  await hashspan.flush();
  await sdk.shutdown();
  process.exit(0);
});
```

The agent, `mcp-client.ts`, starts the server as a child process and calls the tool inside an active span of its
own. With Anvil running, run it with `node --import tsx mcp-client.ts` after installing
`@modelcontextprotocol/client @modelcontextprotocol/server @opentelemetry/sdk-node zod tsx` and the packages of the
[quick start](../README.md#quick-start). The trace shows `pay_vendor` of the service `my-agent`, with `send 31337`
and `confirm 31337` of the service `wallet-mcp` under it:

```ts
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

/** The active trace context as `_meta` keys (`traceparent`, `tracestate`, `baggage`) for one request. */
function traceMeta(): Record<string, string> {
  const meta: Record<string, string> = {};
  propagation.inject(context.active(), meta);
  return meta;
}

// A stdio server gets only a few variables of this environment, such as PATH and HOME: pass on its
// OpenTelemetry and RPC settings. It runs mcp-server.ts next to this file, with this process's Node.js flags (tsx's).
const settings = Object.entries(process.env).filter(
  (entry): entry is [string, string] =>
    (entry[0].startsWith('OTEL_') || entry[0] === 'RPC_URL') && entry[1] !== undefined,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [...process.execArgv, new URL('./mcp-server.ts', import.meta.url).pathname],
  env: { ...getDefaultEnvironment(), ...Object.fromEntries(settings) },
});
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

// The agent's tool call: the server's send and confirm spans become children of this span.
await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const result = await client.callTool({
      name: 'pay_vendor',
      arguments: { amountEth: '0.01' },
      _meta: traceMeta(),
    });
    console.log(result.content);
  } finally {
    span.end();
  }
});

// Closing ends the server's stdin, so it exports its spans and exits; then this process's spans.
await client.close();
await sdk.shutdown();
```

With the v1 SDK, `@arizeai/openinference-instrumentation-mcp` 0.2.36 does both steps for every request, and creates
no spans of its own. Install it, and run this in the agent's process and in the server's:

```ts
import { MCPInstrumentation } from '@arizeai/openinference-instrumentation-mcp';
import * as clientStdioModule from '@modelcontextprotocol/sdk/client/stdio.js';
import * as serverStdioModule from '@modelcontextprotocol/sdk/server/stdio.js';

// In the agent's process and in the server's, after the OpenTelemetry SDK starts and before the transport
// connects: the client's requests carry the active trace context in `_meta`, and the server handles each request
// in that context.
new MCPInstrumentation().manuallyInstrument({ clientStdioModule, serverStdioModule });
```

CI runs all three setups against Anvil in [`integrations/test/mcp.int.test.ts`](../integrations/test/mcp.int.test.ts),
with the agent and the server as separate processes: the v2 files above as written, and a v1 agent and server with
and without the instrumentation. Without it, the server's `send` span is the root of a trace of its own; with it,
and with the v2 setup, `send` and `confirm` are children of the agent's `pay_vendor` span. Known limits:

- **The server's environment:** both SDKs' stdio transports start the server with only a few variables of the
  agent's environment (`getDefaultEnvironment()`), so the server does not see `OTEL_*` settings unless the agent
  passes them in `env`, as above.
- **stdout:** it carries the MCP messages, so the server cannot use a console exporter or log to stdout.
- **Shutting down:** the v1 server transport does not close when stdin ends, and both clients' `close()` waits 2
  seconds for the server to exit before it sends SIGTERM. Flush on the end of stdin, as the server above does, so
  the last spans are exported in time.
- **OpenInference with v2:** the instrumentation's types and its automatic hooks cover only the modules of
  `@modelcontextprotocol/sdk`; use the hand-written lines with the v2 packages.
- **Other transports:** only stdio is checked. The `_meta` lines do not depend on the transport.
- **Which span is the parent:** the tool span must be active in the agent when it calls `callTool`; see
  [agent frameworks](#agent-frameworks) for frameworks whose tool spans are not active. The server takes the
  client's trace context as given, as an HTTP server does with a `traceparent` header.

## Wallet services

How a wallet service sends decides what hashspan records:

- **Services that provide a viem account** sign while viem sends: create a wallet client with that account and extend
  it as in the [viem quick start](../packages/viem/README.md#usage). Every transaction is traced like one signed
  locally.
- **Services that provide an EIP-1193 provider** send when the provider receives `eth_sendTransaction` and return the
  hash: create a wallet client with `custom(provider)`, the wallet's address as `account` and the chain, and extend it
  with `withHashspan()`. viem sends `eth_sendTransaction` for an address-only account, so the send span covers the
  service's call; wait for receipts through an extended public client on an RPC endpoint when the provider does not
  answer reads, or confirm with `watch()` on one. The provider needs to answer only `eth_chainId`, which viem asks
  before it sends, and `eth_sendTransaction`; hashspan sends it nothing else. Background confirmation polls through
  the sending client, so it needs a provider that answers reads.
- **Services that send through their own API** return a transaction hash, sometimes only after polling: record the
  API call as a send span with the core's tracker and the transaction with `watch()` on the same tracker, as in
  [transactions sent elsewhere](../packages/viem/README.md#transactions-sent-elsewhere). The send span then covers the API call, the confirm span the wait, linked
  to it. Without the recorded call, there is only the confirm span.

These services were checked against the source of their published packages, on the versions named; none of them
runs in CI. Their patterns do, on Anvil: a provider that sends after a delay and answers only `eth_chainId`,
`eth_accounts` and `eth_sendTransaction` (`packages/viem/test/eip1193-provider.int.test.ts`), and an API call
recorded as a send (`packages/viem/test/api-wallet.test.ts`).

| Service | How it sends | Use | Spans |
|---|---|---|---|
| Turnkey (`@turnkey/viem` 0.14) | `createAccount()` returns a viem account | `withHashspan()` on the wallet client | send, confirm |
| Privy (`@privy-io/node` 0.35) | `createViemAccount()` from `@privy-io/node/viem` returns a viem account | `withHashspan()` on the wallet client | send, confirm |
| Privy API | `wallets().ethereum().sendTransaction()` returns the `hash` | the call recorded as a send, then `watch()` | send, confirm |
| Privy x402 (`createX402Client()` from `@privy-io/node/x402`, experimental) | returns an `x402Client` | [`@hashspan/x402`](../packages/x402/README.md#usage) on that client, with `@x402/core` 2.13 or later | payment, confirm |
| Circle developer-controlled wallets (`@circle-fin/developer-controlled-wallets` 10.8) | `createEIP1193Provider()` from `/evm`: `eth_sendTransaction` creates the transaction and resolves with its hash once Circle has sent it; other reads go to its `fallback` provider, if one is set | `custom(provider)`; a public client on your RPC endpoint for receipts | send, confirm |
| Circle API | `createTransaction()` returns an id; `getTransaction({ id, waitForState: 'SENT' })` returns the `txHash` | both calls recorded as one send, then `watch()` | send, confirm |
| Fireblocks (`@fireblocks/fireblocks-web3-provider` 1.5) | an EIP-1193 provider: `eth_sendTransaction` creates a Fireblocks transaction and returns its hash; other requests go to its `rpcUrl` | `custom(provider)` with the vault account's address | send, confirm |

- **Send duration:** with an account or a provider from a service, the send span also covers the service's queue and
  its policy or approval steps, so it lasts longer than a local signer's.
- **Privy:** `@privy-io/server-auth` is deprecated in favour of `@privy-io/node`; its `createViemAccount()` works
  the same way.
- **Circle smart contract accounts (ERC-4337):** Circle reports their hash only once the transaction is confirmed;
  this path was not checked.

## Machine Payments Protocol (mppx)

[mppx](https://github.com/wevm/mppx) pays an API's `402 Payment Required` challenge with a Tempo transaction.
[`@hashspan/mpp`](../packages/mpp/README.md#usage) records each payment as a payment span, with the settlement's
confirm span through a reader; it supersedes the setup of a traced `getClient` client and a manual `watch()` on the
receipt's `reference`. What a trace shows depends on who broadcasts the transaction:

| Charge mode | Who broadcasts | Spans, with `@hashspan/mpp` and a reader |
|---|---|---|
| `pull` (the default for a private key) | the server, the transaction the payer signed | payment; confirm, linked to the payment span, from the reader |
| `push` (`mode: 'push'`, or a wallet account) | the payer, through the client mppx's `getClient` returns | payment; send and confirm of the payer's client when it is extended with `@hashspan/viem`'s `withHashspan()`, on the same `tracker`, with the payment span linked to the send span |

1. Extend the payer's viem client with `@hashspan/viem`'s `withHashspan({ tracker })` and pass it to mppx's
   `tempo({ account, getClient })`, so that a push transaction gets its send span.
2. Call `withHashspan(mppx, { tracker, reader })` from `@hashspan/mpp` on the client `Mppx.create()` returns, with the
   same tracker: with two, a push payment gets two confirm spans and two fee samples.
3. Call `flush()` of both before a short-lived process exits.

The payment's fee is the payer's, and is labelled `sponsor` when the server sponsors it as fee payer, never
`facilitator`. The README's quick start runs in CI as written, against an mppx server and Anvil in Tempo mode
(`packages/mpp/test/quick-start.int.test.ts`); the real charges, both modes, sponsored fees and splits, are in
`packages/mpp/test/charge.int.test.ts`. On Anvil in Tempo mode, mine one block before the first charge: a fresh
chain's first block fails Tempo's `validAfter` check in the server's simulation.

## Hardhat 3

Checked with `hardhat` 3.20.0 and, of the plugins of Hardhat's viem project template (`npx hardhat --init`),
`@nomicfoundation/hardhat-viem` 3.0.10, `@nomicfoundation/hardhat-ignition` 3.1.9,
`@nomicfoundation/hardhat-ignition-viem` 3.1.6 and `@nomicfoundation/hardhat-node-test-runner` 3.1.1, on Hardhat's
in-process network. The `viem` helpers of a network connection create new viem clients on every call, and
`deployContract` and `getContractAt` send with clients of their own unless they get a `client` option. Extend the public client and a wallet client with `withHashspan()`, and pass both as `client` to
every helper that sends. A script, `scripts/counter.ts`, after installing the packages of the
[quick start](../README.md#quick-start) in the project, run with `npx hardhat run scripts/counter.ts`:

```ts
import { withHashspan } from '@hashspan/viem';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise.
const sdk = new NodeSDK({ serviceName: 'counter-script' });
sdk.start();

const { viem } = await network.create();
const hashspan = withHashspan();
// hardhat-viem creates new clients for each helper: extend them, and pass them to every helper that sends.
const publicClient = (await viem.getPublicClient()).extend(hashspan);
const [sender] = await viem.getWalletClients();
if (sender === undefined) throw new Error('The network has no accounts');
const client = { public: publicClient, wallet: sender.extend(hashspan) };

// The deployment records a confirm span only: deployContract is not traced yet.
const counter = await viem.deployContract('Counter', [], { client });
const hash = await counter.write.incBy([5n]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`${hash} ${receipt.status}`);

// Before the script ends:
await hashspan.flush();
await sdk.shutdown();
```

The `incBy` call records a `send 31337` and a `confirm 31337` span; the deployment records a `confirm` span only,
since viem's `deployContract` is not traced yet ([#36](https://github.com/selimaytac/hashspan/issues/36)). The
in-process network mines each transaction when it is sent (automine), so a confirm span covers only the wait for a
receipt that is already there.

In a test file of Hardhat's node:test runner, run with `npx hardhat test nodejs`, the same clients are set up once per
suite. The runner runs the test files in Hardhat's own process, so the SDK starts once and shuts down after the last
test:

```ts
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { withHashspan } from '@hashspan/viem';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

// Hardhat runs the test files in its own process: start the SDK once, before the first test.
const sdk = new NodeSDK({ serviceName: 'counter-tests' });
sdk.start();

describe('Counter', async () => {
  const { viem } = await network.create();
  const hashspan = withHashspan();
  const publicClient = (await viem.getPublicClient()).extend(hashspan);
  const [sender] = await viem.getWalletClients();
  if (sender === undefined) throw new Error('The network has no accounts');
  const client = { public: publicClient, wallet: sender.extend(hashspan) };

  after(async () => {
    await hashspan.flush();
    await sdk.shutdown();
  });

  it('adds the increment', async () => {
    const counter = await viem.deployContract('Counter', [], { client });
    const hash = await counter.write.incBy([5n]);
    await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await counter.read.x(), 5n);
  });
});
```

Ignition sends a deployment's transactions through the network connection's provider, not through a viem client, so
`ignition.deploy()` records no spans; `npx hardhat ignition deploy` sends the same way. The contracts it returns send
with clients hardhat-viem creates; bind them to the extended clients with `getContractAt` to trace their calls:

```ts
import { withHashspan } from '@hashspan/viem';
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { network } from 'hardhat';

const sdk = new NodeSDK({ serviceName: 'counter-ignition' });
sdk.start();

const CounterModule = buildModule('CounterModule', (m) => {
  const counter = m.contract('Counter');
  m.call(counter, 'incBy', [5n]);
  return { counter };
});

const { viem, ignition } = await network.create();
const hashspan = withHashspan();
const publicClient = (await viem.getPublicClient()).extend(hashspan);
const [sender] = await viem.getWalletClients();
if (sender === undefined) throw new Error('The network has no accounts');
const client = { public: publicClient, wallet: sender.extend(hashspan) };

// Ignition sends through the network connection's provider, not through a viem client: no spans.
const { counter } = await ignition.deploy(CounterModule);

// The contract Ignition returns sends with clients of its own: bind it to the extended ones.
const traced = await viem.getContractAt('Counter', counter.address, { client });
const hash = await traced.write.incBy([1n]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`${hash} ${receipt.status}`);

await hashspan.flush();
await sdk.shutdown();
```

CI runs the three files above as written, with `hardhat run` and `hardhat test nodejs` in a Hardhat project, in
[`integrations/test/hardhat.int.test.ts`](../integrations/test/hardhat.int.test.ts), and a script without the
`client` option that records no spans. Known limits:

- **Deployments:** with `client`, `deployContract` records only the confirm span of its own wait; without it, nothing.
- **Ignition:** the transactions of a deployment are not traced. Calls after the deployment are, through a contract
  bound with `getContractAt` as above. CI runs `ignition.deploy()` from a script; the CLI task
  `hardhat ignition deploy` is not run.
- **Several test files:** the file above starts and shuts down an SDK of its own. Two such files in one run exported
  only the first file's spans, since Hardhat runs them in one process. Only one test file per run is checked.
- **Networks:** only the in-process network (`edr-simulated`, `chainType: 'l1'`) is checked; `http` networks and the
  `op` chain type are not.

## RPC gateways (eRPC)

[eRPC](https://github.com/erpc/erpc) is a JSON-RPC gateway between an agent and its nodes, with caching, failover
and its own OpenTelemetry spans. It continues the trace of a request that carries a W3C `traceparent` header.
hashspan's JSON-RPC spans send no header, so without HTTP instrumentation each request the agent sends starts a trace
of its own in eRPC. With `@opentelemetry/instrumentation-undici`, which traces Node.js's `fetch` that viem's `http()`
transport uses, every request carries the header and the trace runs from the agent's `send` span through eRPC to the
node. Checked with eRPC 0.4.0 and `@opentelemetry/instrumentation-undici` 0.32.0.

An eRPC config, `erpc.yaml`, for Anvil on 127.0.0.1:8545 and an OTLP/HTTP collector on 127.0.0.1:4318, started with
`erpc --require-config --config erpc.yaml` (without a config, `--require-config` stops eRPC from starting with a
default project of public endpoints):

```yaml
logLevel: info
server:
  listenV4: true
  httpHostV4: 127.0.0.1
  httpPortV4: 4000
  listenV6: false
# eRPC's metrics server listens on every interface whatever metrics.hostV4 says.
metrics:
  enabled: false
tracing:
  enabled: true
  protocol: http
  # host:port, without a scheme: see the known limits below.
  endpoint: 127.0.0.1:4318
  # Below 1, eRPC follows the agent's sampling decision.
  sampleRate: 0.1
  serviceName: erpc
projects:
  - id: main
    upstreams:
      - id: anvil
        endpoint: http://127.0.0.1:8545
        evm:
          chainId: 31337
    networks:
      - architecture: evm
        evm:
          chainId: 31337
```

The agent, `agent.ts`, after installing `@opentelemetry/sdk-node @opentelemetry/instrumentation-undici` and the
packages of the [quick start](../README.md#quick-start), run with `node --import tsx agent.ts`:

```ts
import { traceTransport, withHashspan } from '@hashspan/viem';
import { trace } from '@opentelemetry/api';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Exports over OTLP, to http://localhost:4318 unless OTEL_EXPORTER_OTLP_ENDPOINT says otherwise. The undici
// instrumentation traces each request of Node.js's fetch, which viem's http() transport uses, and sends the
// `traceparent` header that puts eRPC's spans in this trace.
const sdk = new NodeSDK({ serviceName: 'my-agent', instrumentations: [new UndiciInstrumentation()] });
sdk.start();

const account = mnemonicToAccount('test test test test test test test test test test test junk');
// eRPC's project `main` and its network `evm` 31337 in erpc.yaml.
const transport = traceTransport(http(process.env.RPC_URL ?? 'http://127.0.0.1:4000/main/evm/31337'));
const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    console.log(`${hash} ${receipt.status}`);
  } finally {
    span.end();
  }
});

await hashspan.flush();
await sdk.shutdown();
```

The trace shows `pay_vendor` > `send 31337` > `eth_sendRawTransaction` (hashspan) > `POST` (undici) >
`Http.ReceivedRequest` (eRPC) > ... > `HttpJsonRpcClient.sendSingleRequest` (eRPC's call to the node), and the same
for each other request. CI runs the agent above as written against eRPC in front of Anvil, with this config, in
[`integrations/test/erpc.int.test.ts`](../integrations/test/erpc.int.test.ts), and a control without the undici
instrumentation, whose eRPC spans are in traces of their own. Known limits:

- **Two client spans per request:** each JSON-RPC span of `traceTransport()` gets the undici `POST` span as a child,
  and eRPC's server span sits under that one. A span-metrics generator counts both
  ([span metrics](backends.md#span-metrics-and-http-instrumentation)).
- **Tracing endpoint over http:** in eRPC 0.4.0, `tracing.endpoint` with `protocol: http` must be `host:port`. A URL
  with a scheme, and the default endpoint when none is set, export nothing, and the error is logged only at the
  `trace` level ([erpc/erpc#1276](https://github.com/erpc/erpc/issues/1276)).
- **Sampling:** at `sampleRate: 1`, eRPC's default, eRPC records every request whatever the agent decided, so with a
  sampler in the agent, eRPC's spans of the traces the agent dropped show up without their root. Below 1, eRPC follows
  the sampled flag of the header and samples requests without one at that rate. Set a small positive value: eRPC
  reads `0` as unset and uses 1.
- **Multiplexing:** eRPC answers identical requests that arrive together with one call to the node, on by default.
  The trace of a request that waits for another one's call has eRPC's `Network.WaitForMultiplexResult` span and no
  span of the node call, which is only in the other request's trace, with no link to it. `multiplexing: false` on the
  network gives each request its own call. A cache hit has no node call either.
- **Baggage:** eRPC passes `tracestate` on to the node, but not `baggage`.
- **Header from hashspan:** a later release of `@hashspan/viem` is planned to send the header from the JSON-RPC span
  itself, without the extra `POST` span. Use that option or the undici instrumentation, never both: the undici
  instrumentation adds a second `traceparent` line rather than replacing the first, and a proxy that joins the two
  into one value makes eRPC start a new trace for every request.
- **Other transports:** only HTTP is checked; eRPC does not continue a trace over gRPC, and viem does not send to it
  over gRPC.
