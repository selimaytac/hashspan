# Example: AI SDK agent with traced transactions

A treasury agent built with the [AI SDK](https://ai-sdk.dev) whose tools send transactions with viem. With
`@hashspan/viem`, every transaction shows up inside the agent's trace:

```
invoke_agent                       gen_ai.agent.name=treasury-agent
├─ step 1
│  └─ execute_tool pay_vendor
│     ├─ send 31337                blockchain.tx.value=250000000000000000
│     └─ confirm 31337             blockchain.tx.status=success, blockchain.tx.fee=...
└─ step 2
   └─ execute_tool withdraw_from_vault
      ├─ send 31337                blockchain.contract.function.name=withdraw
      └─ confirm 31337             blockchain.tx.status=reverted
                                   blockchain.tx.revert.reason=WithdrawalLimitExceeded(100000000000000000, 1000000000000000000)
```

![The example agent's trace in Jaeger](../../docs/images/jaeger-trace.png)

It runs offline and needs no API key: a scripted model makes the tool calls, and the transactions go to a local
Anvil chain.

## Run it

From the repository root:

```sh
make lab-up   # Jaeger UI on http://localhost:16686
make demo     # starts a local chain, runs the agent, stops the chain
```

`make demo` needs port 8545 to be free: it starts its own chain there and fails if something already listens on it
(such as a running `make anvil`).

Open Jaeger, pick the service `treasury-agent` and open the trace. To print spans instead, run
`OTEL_TRACES_EXPORTER=console make demo`. The setup reads the standard OpenTelemetry variables:
`OTEL_SERVICE_NAME=my-agent make demo` files the trace under `my-agent`, and `OTEL_EXPORTER_OTLP_ENDPOINT` sends it
to another backend.

## Run it on Base Sepolia

The same agent runs on the Base Sepolia testnet with an account of your own. Use a key made for this testnet only,
fund it from a Base Sepolia faucet (0.0001 test ETH is plenty), and keep the key in a file outside the repository:

```sh
# base-sepolia.env, readable only by you (chmod 600)
BASE_SEPOLIA_PRIVATE_KEY=0x...
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org   # optional; this is the default
```

```sh
make lab-up
set -a; . /path/to/base-sepolia.env; set +a
make demo-base-sepolia
```

The run checks that the RPC reports chain id 84532 and refuses any other chain, and stops before sending anything if
the balance does not cover it. It deploys the demo vault (not traced, as it is setup rather than the agent's work),
pays 0.00001 ETH to the account itself, so the payment comes back, and tries a withdrawal that the vault rejects.
It prints a Basescan link for each transaction; the spans are named `send 84532` and `confirm 84532`. Errors are
printed without the key or the RPC URL.

## How it is wired

| File | What it shows |
|---|---|
| [`src/main.ts`](src/main.ts) | The entry point: starts telemetry before importing the rest, picks the chain (`base-sepolia` or local), prints the results, and shuts telemetry down |
| [`src/telemetry.ts`](src/telemetry.ts) | A standard OpenTelemetry SDK setup plus the AI SDK's OpenTelemetry integration |
| [`src/chain.ts`](src/chain.ts) | One `withHashspan()` result shared by the wallet and public client |
| [`src/base-sepolia.ts`](src/base-sepolia.ts) | The same clients on Base Sepolia, with a private key from the environment |
| [`src/tools.ts`](src/tools.ts) | Plain AI SDK tools calling `sendTransaction`, `writeContract` and `waitForTransactionReceipt` |
| [`src/demo.ts`](src/demo.ts) | The agent run, and `hashspan.flush()` before the process exits |
| [`src/model.ts`](src/model.ts) | The scripted model standing in for an LLM |

The tools contain no tracing code: the AI SDK runs each tool inside its `execute_tool` span, so the transaction
spans become its children.

To use a real model, replace `scriptedModel()` in `src/demo.ts` with any AI SDK model, for example
`openai('...')` from `@ai-sdk/openai` with `OPENAI_API_KEY` set.

The demo vault rejects every withdrawal, to show a reverted transaction. On the local chain it is installed with
`anvil_setCode`, and the wallet is Anvil's first test account, which Anvil signs for, so the example holds no
private key. On Base Sepolia the vault is deployed, and the key comes from the environment.
