# Integrations

Agents rarely call viem or the CDP SDK directly: a toolkit, a framework or a wallet service sits in between. hashspan
traces the client those libraries send through, so most integrations come down to handing them a traced client.
This page collects the setups that were checked; each code block is compiled in CI.

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
ERC-20 actions) then record a `send` and a `confirm` span per transaction. This was run against Anvil: without
background confirmation, only the send spans are recorded.

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

The provider calls `cdp.evm.sendTransaction`, which the wrapper traces. This setup was checked against the
provider's source, not run: the provider creates its `CdpClient` without options that would let a test point it at
a local API.

The same setup covers `CdpSmartWalletProvider`, which also has `getClient()` and `getPublicClient()`: it sends ERC-4337
user operations with `cdp.evm.sendUserOperation` and waits with `cdp.evm.waitForUserOperation`, which the wrapper
records as user operation spans ([smart accounts](../packages/cdp/README.md#smart-accounts)). This too was checked
against the provider's source.

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
`send` and a `confirm` span; this was run against Anvil. `@goat-sdk/wallet-viem` pins its own viem version, so the
wallet client must be created with a viem that GOAT accepts.

## Agent frameworks

hashspan's spans are children of the OpenTelemetry span that is active when the transaction is sent. Whether a
framework's tool-call span is that span depends on its instrumentation:

- **Mastra:** with its OpenTelemetry bridge (`OtelBridge` from `@mastra/otel-bridge`, set as `bridge` in an
  `Observability` config of `@mastra/observability`) and a registered tracer provider and context manager (the
  OpenTelemetry Node SDK registers both), each tool runs inside its tool span. Checked with `@mastra/core` 1.74.0 and
  `@mastra/otel-bridge` 1.5.13, running an agent against Anvil: the trace reads `invoke_agent`, then
  `execute_tool pay_vendor`, then `send` and `confirm`. Without Mastra observability, the send and confirm spans
  start traces of their own. Mastra marks the bridge as experimental.
- **LangChain JS and the OpenAI Agents SDK:** OpenInference's instrumentations
  (`@arizeai/openinference-instrumentation-langchain` 4.1.4, `@arizeai/openinference-instrumentation-openai-agents`
  0.3.2) record tool spans but do not make them active, so hashspan's spans attach to whatever span was active
  before the agent ran. To group a tool's transactions, run the tool's function in an active span of your own:

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
