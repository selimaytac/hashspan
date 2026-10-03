# Integrations

Agents rarely call viem or the CDP SDK directly: a toolkit, a framework or a wallet service sits in between. hashspan
traces the client those libraries send through, so most integrations come down to handing them a traced client.
This page collects the setups that were checked; each code block is compiled in CI. When a span is missing, see
[troubleshooting](troubleshooting.md).

## Support at a glance

| Setup | Use | Extra setup | Known limits | Runs in CI |
|---|---|---|---|---|
| viem wallet and public clients | `@hashspan/viem` [`withHashspan()`](../packages/viem/README.md#usage) | apply it last; one result per agent | a library that calls viem's actions as functions is not traced ([below](#libraries-that-take-a-viem-client)) | `packages/viem` tests |
| viem bundler client (ERC-4337) | `@hashspan/viem` | a tracker from `@hashspan/core` 0.8 or later | no background confirmation or `watch()` for user operations ([smart accounts](../packages/viem/README.md#smart-accounts-erc-4337)) | `packages/viem` tests, a real bundler in CI only |
| EIP-5792 wallet (`sendCalls`) | `@hashspan/viem` | none | no fees on the batch; `getCallsStatus` is not traced ([call batches](../packages/viem/README.md#call-batches-eip-5792)) | `packages/viem` tests |
| Transactions sent elsewhere | `@hashspan/viem` [`watch()`](../packages/viem/README.md#transactions-sent-elsewhere) | a public client | no send span | `packages/viem` tests |
| Coinbase CDP SDK | `@hashspan/cdp` | a `reader` for confirm spans | CommonJS needs Node.js 22.12 ([install](../packages/cdp/README.md#install)); see [traced calls](../packages/cdp/README.md#traced) | `packages/cdp` tests |
| x402 client | `@hashspan/x402` | a `reader` for `verified` | x402 v1 and non-`eip155` networks are not traced ([recorded](../packages/x402/README.md#recorded)) | `packages/x402` tests |
| AgentKit `ViemWalletProvider` | `@hashspan/viem` | background confirmation | TypeScript needs a cast ([setup](#viemwalletprovider)) | `integrations/` |
| AgentKit `CdpEvmWalletProvider`, `CdpSmartWalletProvider` | `@hashspan/cdp` on `getClient()` | the provider's public client as `reader` | `configureWithWallet()` itself is not run in CI ([setup](#cdpevmwalletprovider)) | `integrations/` |
| Other AgentKit wallet providers | `@hashspan/viem` `watch()` | the returned hash | no send span ([setup](#other-wallet-providers)) | no |
| GOAT | `@hashspan/viem` | background confirmation | no longer maintained ([setup](#goat-sdk)) | `integrations/` |
| Mastra | `@hashspan/viem` | Mastra's OpenTelemetry bridge | the bridge is experimental ([setup](#agent-frameworks)) | `integrations/` |
| LangChain JS, OpenAI Agents SDK (OpenInference) | `@hashspan/viem` | run tools in an active span of your own | tool spans are not active ([setup](#agent-frameworks)) | `integrations/` |
| ElizaOS `plugin-evm` | none | none | not traced: it creates its own wallet client ([details](#agent-frameworks)) | no |
| Wallet services with a viem account | `@hashspan/viem` | none | none ([setup](#wallet-services)) | as viem clients |
| Wallet services that send through their API | `@hashspan/viem` `watch()` | a public client | no send span ([setup](#wallet-services)) | no |

## Libraries that take a viem client

When a library accepts a viem wallet client, extend the client before you hand it over:

- `client.extend(withHashspan())` traces `sendTransaction` and `writeContract` as long as the library calls them as
  methods of that client. A library that calls viem's actions with the client as an argument
  (`sendTransaction(client, ...)` from `viem/actions`) bypasses client extensions and is not traced.
- If the library waits for receipts on a client of its own, the confirm span is not recorded by that wait. Use
  [background confirmation](../packages/viem/README.md#background-confirmation) so hashspan polls for the receipt
  itself.
- Apply `withHashspan()` last ([why](../packages/viem/README.md#apply-it-last)).

## Coinbase AgentKit

Checked with `@coinbase/agentkit` 0.10.4. AgentKit sends through a wallet provider; three of them can be traced
without extra code.

### `ViemWalletProvider`

The provider sends with the wallet client you give it, and waits for receipts with a public client it creates
itself, so the setup needs background confirmation:

```ts
// The provider waits for receipts on a client of its own: background confirmation records them.
const hashspan = withHashspan({ confirm: { mode: 'background' } });
const walletClient = createWalletClient({ account, chain, transport: http() }).extend(hashspan);
const walletProvider = new ViemWalletProvider(walletClient);

// Before a short-lived process exits:
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
  same viem version as AgentKit, no cast is needed.

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
  [`watch()`](../packages/viem/README.md#transactions-sent-elsewhere) and the hash the provider returns.

AgentKit reports each wallet provider's initialization and each action invocation to its analytics endpoint; this
is AgentKit's own behaviour and independent of hashspan. In 0.10.4, a failed analytics request, for example where a
firewall blocks the endpoint, ends the Node.js process
([coinbase/agentkit#1531](https://github.com/coinbase/agentkit/issues/1531)).

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
framework's tool-call span is that span depends on its instrumentation:

- **Mastra:** with its OpenTelemetry bridge (`OtelBridge` from `@mastra/otel-bridge`, set as `bridge` in an
  `Observability` config of `@mastra/observability`) and a registered tracer provider and context manager (the
  OpenTelemetry Node SDK registers both), each tool runs inside its tool span: the trace reads
  `invoke_agent <agent>`, then Mastra's spans of the model call and the agent's step, then `execute_tool <tool>`,
  whose children are `send` and `confirm`. Without Mastra observability, the send and confirm spans start traces of
  their own. CI runs both setups against Anvil with a scripted model, from `@mastra/core` 1.74.0 and
  `@mastra/otel-bridge` 1.5.13 on, in [`integrations/test/mastra.int.test.ts`](../integrations/test/mastra.int.test.ts).
  Mastra marks the bridge as experimental.
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

## Wallet services

- **Services that provide a viem account**, such as Privy's server wallets through `createViemAccount` or Turnkey's
  viem integration, sign while viem sends: create a wallet client with that account and extend it as in the
  [viem quick start](../packages/viem/README.md#usage). Every transaction is traced like one signed locally.
- **Services that send through their own API**, such as a server wallet API that returns a transaction hash: record
  the transaction with [`watch()`](../packages/viem/README.md#transactions-sent-elsewhere) and a public client of
  your own. The confirm span then covers the wait; there is no send span, since the send happened elsewhere.
