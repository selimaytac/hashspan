# Example: an AI SDK agent that pays an x402 API

A research agent built with the [AI SDK](https://ai-sdk.dev) that does two things on chain: it tips a report's author
in ETH with a viem transaction, and it buys a report from a paid API with [x402](https://www.x402.org). With
`@hashspan/viem` and `@hashspan/x402`, both show up inside the agent's trace:

```
invoke_agent                       gen_ai.agent.name=research-agent (on the hashspan spans)
├─ step 1
│  └─ execute_tool tip_author
│     ├─ send 31337                blockchain.tx.value=10000000000000000
│     └─ confirm 31337             blockchain.tx.status=success, linked to the send span
└─ step 2
   └─ execute_tool buy_report
      ├─ payment 31337             blockchain.payment.status=settled, blockchain.payment.verified=true
      │                            blockchain.payment.amount=10000, x402.scheme=exact
      └─ confirm 31337             blockchain.tx.status=success, linked to the payment span
```

The agent sends the tip itself, so it gets a `send` span. It does not send the payment's transaction: it signs an
EIP-3009 authorization, and the API's facilitator settles it from its own account. So the payment has a `payment`
span instead, and a `confirm` span for the facilitator's settling transaction, linked to the payment. With a reader,
`blockchain.payment.verified=true` says that the settling transaction's receipt carries this payment. The attributes
are described in [docs/semconv.md](../../docs/semconv.md).

It runs offline and needs no API key and no funds: a scripted model makes the tool calls, the transactions go to a
local Anvil chain, and the paid API, its facilitator and the token it is paid in all run on your machine.

## Run it

From the repository root, after `nvm use && corepack enable pnpm && pnpm install`:

```sh
make lab-up   # Jaeger UI on http://localhost:16686
make anvil    # in a second terminal: a local chain on 127.0.0.1:8545
pnpm build    # the hashspan packages the example imports
pnpm --filter @hashspan/example-x402-agent start
```

Open Jaeger, pick the service `research-agent` and open the trace. To print spans instead, set
`OTEL_TRACES_EXPORTER=console`; `OTEL_EXPORTER_OTLP_ENDPOINT` sends them to another backend. `RPC_URL` points the
example at another local Anvil, and `PAID_API_PORT` serves the paid API on a fixed port instead of a free one.

Each run deploys a fresh Test USD contract and makes a fresh agent account, so it can run again on the same chain.

`test/agent.int.test.ts` runs `src/main.ts` the same way in CI, on a fresh Anvil, and checks the trace above as it
arrives over OTLP.

## How it is wired

| File | What it shows |
|---|---|
| [`src/main.ts`](src/main.ts) | The entry point: starts telemetry before importing the rest, prints the results, and shuts telemetry down |
| [`src/telemetry.ts`](src/telemetry.ts) | The OpenTelemetry `NodeSDK` plus the AI SDK's OpenTelemetry integration |
| [`src/chain.ts`](src/chain.ts) | One tracker with the agent identity, shared by both adapters; the local chain's setup: the agent account, Test USD |
| [`src/payments.ts`](src/payments.ts) | The agent's `x402Client`: `withHashspan` from `@hashspan/x402` with a reader, the `exact` scheme and spend controls |
| [`src/paid-api.ts`](src/paid-api.ts) | The paid API: Hono with `paymentMiddleware` from `@x402/hono`, and a facilitator in the same process |
| [`src/tools.ts`](src/tools.ts) | Plain AI SDK tools: `sendTransaction` and `waitForTransactionReceipt`, and a `fetch` that pays |
| [`src/demo.ts`](src/demo.ts) | The agent run, and `flush()` of both adapters before the process exits |
| [`src/model.ts`](src/model.ts) | The scripted model standing in for an LLM |

The tools contain no tracing code: the AI SDK runs each tool inside its `execute_tool` span, so the spans of its
transaction or payment become its children.

- **The token:** Test USD, the EIP-3009 token of hashspan's x402 tests
  ([`TestUsd.sol`](../../packages/x402/test/token/TestUsd.sol), compiled into `test-usd.ts` next to it). Anyone can
  mint it, so it is for local chains only. Anvil's first account deploys it and mints 1 Test USD to the agent.
- **The agent account:** a private key made for each run (`generatePrivateKey()`), given 1 ETH with
  `anvil_setBalance`. It sends the tip and signs the payment; the example holds no key.
- **The facilitator:** `x402Facilitator` with the `exact` EVM scheme, signing as Anvil's first account, which Anvil
  signs for and which pays the settlement's gas. A real API calls a facilitator service instead.
- **Spend controls:** the client accepts only the scheme's default assets, such as USDC, unless told otherwise.
  `setSpendControls()` allows Test USD, up to 0.05 Test USD per payment; a payment over the cap is refused before it is
  signed, and is not traced.

To use a real model, replace `scriptedModel()` in `src/demo.ts` with any AI SDK model, for example
`openai('...')` from `@ai-sdk/openai` with `OPENAI_API_KEY` set.

## Base Sepolia (optional, not run in CI)

The same code pays on the Base Sepolia testnet with these changes. CI does not run them, and they are not tested:
treat this as a starting point, not a recipe.

- **Chain and RPC URL:** `baseSepolia` from `viem/chains` instead of `foundry`, `http('https://sepolia.base.org')` or
  your provider's URL, and the network `eip155:84532`; spans are then named `send 84532`, `payment 84532` and
  `confirm 84532`.
- **The agent account:** a key made for this testnet only, from the environment, never from the repository, funded
  with test ETH (for the tip) and test USDC from a faucet. Skip `prepareLocalChain()`: there is no `anvil_setBalance`
  and no Test USD.
- **The asset:** USDC on Base Sepolia, `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. It is one of the `exact`
  scheme's default assets, so the route's price can be `'$0.01'`, and the spend controls need no `allowedAssets`
  entry; their default cap is $1 per payment.
- **The facilitator:** `new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' })` from `@x402/core/server`,
  the public testnet facilitator, in place of `localFacilitator()`. It settles from its own account, so the API needs
  no key either.

The trace has the same shape, with Basescan (`https://sepolia.basescan.org/tx/<hash>`) showing the transactions.
